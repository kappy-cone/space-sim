// 3D interactive flight view. The simulation stays planar (3-DOF in the
// orbital plane); this view embeds that plane in 3D — sim (x, y) maps to
// world (x, 0, −y) so the orbit is horizontal — and renders the actual
// craft the player built, part meshes and all, at the simulated attitude.
// Precision at planetary distances comes from the renderer's float64
// camera-relative pipeline; orbit/trail line vertices are rebased to the
// vehicle so nothing wobbles up close.

import { PARTS, partById } from '../craft/catalog';
import { Compiled } from '../craft/compile';
import { Craft, placements } from '../craft/craft';
import { Autopilot, defaultPlan } from '../physics/autopilot';
import { BODIES, bodyById, bodyOrbitState } from '../physics/bodies';
import { LandingAutopilot } from '../physics/landing';
import { Sim, TOUCHDOWN_LIMITS } from '../physics/sim';
import { massFromStage, stageIgnitionLimit, stageMinThrottle, stageThrustAtPressure } from '../physics/vehicle';
import { engineById } from '../physics/parts';
import { machDragFactor, speedOfSound } from '../physics/atmosphere';
import { add, norm, perp, scale, sub, vec } from '../physics/vec2';
import { P0_SEA_LEVEL } from '../physics/constants';
import { OrbitCamera } from '../gl/camera';
import {
  Mat4,
  multiply,
  rotationY,
  rotationZ,
  scaling,
  scalingXYZ,
  translation,
  v3,
} from '../gl/mat4';
import { finMesh, groundCapMesh, moonColor, segmentsMesh, sphereMesh, terrainColor, wingMesh } from '../gl/mesh';
import { planeStability } from '../physics/massmodel';
import { SITES } from '../physics/sites';
import { Renderer } from '../gl/renderer';
import { fmtDistance, fmtMass, fmtSpeed, fmtTime } from './format';

// 10,000× exists for translunar coasts (a transfer is ~5 days); coasts
// ride analytic Kepler so high warp costs nothing in accuracy.
const WARP_STEPS = [1, 2, 5, 10, 25, 100, 1000, 10_000];

interface PartInstance {
  partId: string;
  defId: string;
  isFin: boolean;
  isLeg: boolean;
  height: number;
  hScale: number;
  burnIndex: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  color: [number, number, number];
  // engine plume info
  engine: boolean;
  exitRadius: number;
  /** Nozzle exit pressure proxy [Pa] for plume expansion visuals. */
  pExit: number;
}

/**
 * One live vehicle in the scene. vessels[0] is the launched craft;
 * further vessels are born from release pylons (air launch). The
 * Flight3D singular fields hold the ACTIVE vessel's working set;
 * bundles park everything else and swap on `[`/`]`.
 */
interface Vessel {
  name: string;
  sim: Sim;
  compiled: Compiled;
  instances: PartInstance[];
  geomLength: number;
  trail: { x: number; y: number; t: number }[];
  lastTrailT: number;
  seenEvents: number;
  ap: Autopilot;
  autopilotOn: boolean;
  landAp: LandingAutopilot;
  autoLand: boolean;
  manualPitch: number;
  stagingEntries: StagingEntry[];
  consumedEntries: Set<number>;
}

interface StagingEntry {
  kind: 'sep' | 'deploy' | 'nozzle' | 'release';
  afterStage: number;
  label: string;
  effect?: 'legs' | 'chutes' | 'fairing';
}

export class Flight3D {
  private sim: Sim;
  private ap: Autopilot;
  private autopilotOn = true;
  private vessels: Vessel[] = [];
  private activeIndex = 0;
  private manualPitch = 0;
  private warpIndex = 0;
  private running = false;
  private raf = 0;
  private lastFrame = 0;
  private seenEvents = 0;

  private renderer: Renderer;
  private camera = new OrbitCamera();
  private canvas: HTMLCanvasElement;

  private instances: PartInstance[] = [];
  /** Trail points in the CURRENT reference frame, with the sim time each
   * was recorded at — needed to convert them across SOI transitions. */
  private trail: { x: number; y: number; t: number }[] = [];
  private geomLength = 20;
  private landAp = new LandingAutopilot();
  private autoLand = false;
  private frameCount = 0;
  private landingPanelShown = false;
  /** Airflow streak parcels, positions relative to the vehicle [m]. */
  private streaks: { x: number; y: number; z: number }[] = [];
  private lastWallDt = 1 / 60;
  /** Impact predictor result: sim-plane angle + seconds from now. */
  private impact: { angle: number; dt: number } | null = null;

  /** KSP-style staging sequence: separations plus deployables. Entries
   * are "consumed" implicitly when the sim state already reflects them
   * (autopilot separations, manual P/G deploys), so space always
   * triggers the next action that still makes sense. */
  private stagingEntries: StagingEntry[] = [];
  private consumedEntries = new Set<number>();
  private stageBtn!: HTMLButtonElement;

  private hudValues = new Map<string, HTMLElement>();
  private propFill!: HTMLElement;
  private landingPanel!: HTMLElement;
  private banner!: HTMLElement;
  private feed!: HTMLElement;
  private launchBtn!: HTMLButtonElement;
  private apBtn!: HTMLButtonElement;
  private warpLabel!: HTMLElement;
  private throttleSlider!: HTMLInputElement;

  constructor(
    private root: HTMLElement,
    private compiled: Compiled,
    craft: Craft,
    private targetAltitude = 250_000,
    private onExit?: () => void,
  ) {
    this.sim = new Sim(compiled.vehicle);
    this.ap = new Autopilot(defaultPlan(targetAltitude, this.sim.body));
    if (compiled.vehicle.planeAero) {
      // Planes start on the runway, nose on the horizon; arrows pitch
      // from there (rotation is what lifts the nose at Vr). The ascent
      // autopilot is a rocket gravity-turn program — planes fly manual.
      this.manualPitch = Math.PI / 2;
      this.sim.attitude = { mode: 'pitch', angle: Math.PI / 2 };
      this.autopilotOn = false;
    }

    // Flatten the craft to renderable instances with burn-order indices.
    this.instances = buildInstances(compiled, craft);

    root.innerHTML = '';
    root.className = 'flight';
    this.canvas = document.createElement('canvas');
    root.appendChild(this.canvas);
    this.renderer = new Renderer(this.canvas);
    for (const def of PARTS) {
      const f = def.fin;
      const w = def.wing;
      this.renderer.mesh(def.id, () =>
        w ? wingMesh(w.cr, w.ct, w.span, w.sweep) : f ? finMesh(f.cr, f.ct, f.span, f.sweep, f.thickness) : segmentsMesh(def.segments),
      );
    }
    // One terrain sphere + local ground cap per body (the reference body
    // is mutable across SOI transitions). The cap is a 60 km patch
    // anchored at the sub-vehicle surface point, 0.15 m below the datum
    // so the pad deck stays proud of it.
    this.renderer.mesh('planet-earth', () => sphereMesh(48, 72, terrainColor));
    this.renderer.mesh('planet-moon', () => sphereMesh(48, 72, moonColor));
    for (const b of BODIES) {
      this.renderer.mesh(`cap-${b.id}`, () => groundCapMesh(b.radius, 60_000, 0.15));
    }
    this.renderer.mesh('shell', () => sphereMesh(24, 36));
    this.renderer.mesh('plume', () => segmentsMesh([{ y0: -1, y1: 0, r0: 0.45, r1: 1 }]));
    this.renderer.mesh('pad', () => segmentsMesh([{ y0: 0, y1: 1, r0: 1, r1: 0 }]));
    this.renderer.mesh('padDisc', () => segmentsMesh([{ y0: -1, y1: 0, r0: 1, r1: 1 }]));
    this.renderer.mesh('canopy', () => sphereMesh(12, 18));
    this.renderer.mesh('arrow', () =>
      segmentsMesh([
        { y0: 0, y1: 0.8, r0: 0.02, r1: 0.02 },
        { y0: 0.8, y1: 1, r0: 0.07, r1: 0 },
      ]),
    );

    this.stagingEntries = buildStagingEntries(compiled);
    this.geomLength = compiled.geometry.length;
    // Vessel 0 is the launched craft; the bundle shares its object
    // references with the singular working-set fields.
    this.vessels.push({
      name: craft.name,
      sim: this.sim,
      compiled,
      instances: this.instances,
      geomLength: this.geomLength,
      trail: this.trail,
      lastTrailT: -1,
      seenEvents: 0,
      ap: this.ap,
      autopilotOn: this.autopilotOn,
      landAp: this.landAp,
      autoLand: false,
      manualPitch: this.manualPitch,
      stagingEntries: this.stagingEntries,
      consumedEntries: this.consumedEntries,
    });
    this.camera.minDist = 8;
    this.camera.maxDist = 6e7;
    // Open framing the whole vehicle, whatever its size.
    this.camera.dist = Math.max(55, this.geomLength * 2.1);
    this.camera.yaw = 0.9;
    this.camera.pitch = 0.15;
    this.camera.attach(root, () => {});
    this.attachSteering(root);

    this.buildHud();
    this.buildControls();
    // Debug hook, same convention as window.__vab in the builder.
    (window as unknown as { __flight?: Flight3D }).__flight = this;
    window.addEventListener('keydown', this.onKey);
    new ResizeObserver(() => this.resize()).observe(root);
    this.resize();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
  }

  // ---------- DOM ----------

  private buildHud(): void {
    const hud = document.createElement('div');
    hud.className = 'hud';
    const flight = document.createElement('div');
    flight.className = 'panel';
    flight.innerHTML = '<h3>Flight</h3>';
    const grid = document.createElement('div');
    grid.className = 'readouts';
    flight.appendChild(grid);
    const rows: [string, string][] = [
      ['met', 'MET'],
      ['phase', 'Phase'],
      ...(this.compiled.released ? ([['vessel', 'Vessel']] as [string, string][]) : []),
      ['refbody', 'Ref body'],
      ['alt', 'Altitude'],
      ['air', 'Airspeed'],
      ['orb', 'Orbital vel'],
      ['ap', 'Apoapsis'],
      ['pe', 'Periapsis'],
      ['tapo', 'Time to Ap'],
      ['twr', 'TWR'],
      ['throttle', 'Throttle'],
      ['q', 'Dyn press'],
      ['mach', 'Mach'],
      ['aoa', 'AoA'],
      ...(this.compiled.vehicle.planeAero
        ? ([
            ['stall', 'Stall margin'],
            ['trim', 'Elevator'],
          ] as [string, string][])
        : []),
      ['margin', 'Stability'],
      ['gimbal', 'Gimbal'],
      ['settle', 'Prop state'],
      ['rcs', 'RCS/ullage'],
    ];
    for (const [key, label] of rows) {
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'value';
      grid.appendChild(l);
      grid.appendChild(v);
      this.hudValues.set(key, v);
    }
    const propPanel = document.createElement('div');
    propPanel.className = 'panel';
    propPanel.innerHTML = '<h3>Propellant</h3>';
    const propLabel = document.createElement('div');
    propLabel.className = 'value';
    this.hudValues.set('prop', propLabel);
    const bar = document.createElement('div');
    bar.className = 'prop-bar';
    this.propFill = document.createElement('div');
    bar.appendChild(this.propFill);
    propPanel.appendChild(propLabel);
    propPanel.appendChild(bar);
    hud.appendChild(flight);
    hud.appendChild(propPanel);

    // Landing instruments: appear during descent. Radar altitude is above
    // the actual surface under the vehicle, distinct from CoM altitude.
    this.landingPanel = document.createElement('div');
    this.landingPanel.className = 'panel';
    this.landingPanel.style.display = 'none';
    this.landingPanel.innerHTML = '<h3>Landing</h3>';
    const lgrid = document.createElement('div');
    lgrid.className = 'readouts';
    this.landingPanel.appendChild(lgrid);
    const lrows: [string, string][] = [
      ['radar', 'Radar alt'],
      ['vspd', 'V speed'],
      ['hspd', 'H speed'],
      ['ltilt', 'Tilt'],
      ['burnalt', 'Burn alt'],
      ['impact', 'Impact in'],
      ['gear', 'Gear/chute'],
    ];
    for (const [key, label] of lrows) {
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'value';
      lgrid.appendChild(l);
      lgrid.appendChild(v);
      this.hudValues.set(key, v);
    }
    hud.appendChild(this.landingPanel);

    this.feed = document.createElement('div');
    this.feed.className = 'panel event-feed';
    hud.appendChild(this.feed);
    this.root.appendChild(hud);

    this.banner = document.createElement('div');
    this.banner.className = 'banner';
    this.banner.style.display = 'none';
    this.root.appendChild(this.banner);
  }

  private buildControls(): void {
    const bar = document.createElement('div');
    bar.className = 'controls';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.display = 'flex';
    panel.style.gap = '8px';
    panel.style.alignItems = 'center';

    if (this.onExit) {
      const back = document.createElement('button');
      back.textContent = '◂ VAB';
      back.onclick = () => this.onExit!();
      panel.appendChild(back);
    }
    this.launchBtn = document.createElement('button');
    this.launchBtn.className = 'primary';
    this.launchBtn.textContent = 'Launch';
    this.launchBtn.onclick = () => this.launch();
    this.apBtn = document.createElement('button');
    this.apBtn.textContent = `Autopilot: ${this.autopilotOn ? 'on' : 'off'}`;
    this.apBtn.onclick = () => this.toggleAutopilot();
    const stageBtn = document.createElement('button');
    stageBtn.textContent = 'Stage (space)';
    stageBtn.onclick = () => this.nextStageAction();
    this.stageBtn = stageBtn;
    const warpDown = document.createElement('button');
    warpDown.textContent = '−';
    warpDown.onclick = () => this.setWarp(this.warpIndex - 1);
    this.warpLabel = document.createElement('span');
    this.warpLabel.className = 'value';
    this.warpLabel.style.minWidth = '52px';
    this.warpLabel.style.textAlign = 'center';
    this.warpLabel.textContent = '1×';
    const warpUp = document.createElement('button');
    warpUp.textContent = '+';
    warpUp.onclick = () => this.setWarp(this.warpIndex + 1);

    // Throttle slider: live in manual; mirrors the autopilot's command
    // when the autopilot owns the throttle.
    const thr = document.createElement('input');
    thr.type = 'range';
    thr.min = '0';
    thr.max = '100';
    thr.value = '100';
    thr.className = 'throttle-slider';
    thr.oninput = () => {
      if (!this.autopilotOn) this.sim.throttle = Number(thr.value) / 100;
    };
    this.throttleSlider = thr;

    const hasGear = !!this.compiled.vehicle.gear;
    const legsBtn = document.createElement('button');
    legsBtn.textContent = hasGear ? 'Gear (G)' : 'Legs (G)';
    legsBtn.onclick = () => this.sim.deploy(hasGear ? 'gear' : 'legs');
    const chuteBtn = document.createElement('button');
    chuteBtn.textContent = 'Chute (P)';
    chuteBtn.onclick = () => this.sim.deployChutes();
    const landBtn = document.createElement('button');
    landBtn.textContent = 'Auto-land: off';
    landBtn.onclick = () => {
      this.autoLand = !this.autoLand;
      if (this.autoLand && this.autopilotOn) this.toggleAutopilot();
      landBtn.textContent = `Auto-land: ${this.autoLand ? 'on' : 'off'}`;
    };

    panel.append(this.launchBtn, this.apBtn, landBtn, stageBtn, legsBtn, chuteBtn, thr, warpDown, this.warpLabel, warpUp);
    bar.appendChild(panel);

    const hint = document.createElement('div');
    hint.className = 'vab-hint';
    hint.style.bottom = '62px';
    hint.textContent = 'space: launch/stage · A: autopilot · ← →: pitch · ↑ ↓: throttle · Z/X: full/cut · T: RCS settle · U: ullage motor · N: nozzle · , .: warp';
    this.root.appendChild(hint);
    this.root.appendChild(bar);
  }

  private launch(): void {
    if (this.running) return;
    this.running = true;
    this.launchBtn.disabled = true;
  }

  // ---------- vessels (air launch) ----------

  /** Park the active vessel's working set back into its bundle. */
  private syncActive(): void {
    const v = this.vessels[this.activeIndex]!;
    v.sim = this.sim;
    v.compiled = this.compiled;
    v.instances = this.instances;
    v.geomLength = this.geomLength;
    v.trail = this.trail;
    v.seenEvents = this.seenEvents;
    v.ap = this.ap;
    v.autopilotOn = this.autopilotOn;
    v.landAp = this.landAp;
    v.autoLand = this.autoLand;
    v.manualPitch = this.manualPitch;
    v.stagingEntries = this.stagingEntries;
    v.consumedEntries = this.consumedEntries;
  }

  /** Switch control/camera/HUD to vessel i (crashed ones stay viewable). */
  switchVessel(i: number): void {
    const n = this.vessels.length;
    if (n < 2) return;
    this.syncActive();
    this.activeIndex = ((i % n) + n) % n;
    const v = this.vessels[this.activeIndex]!;
    this.sim = v.sim;
    this.compiled = v.compiled;
    this.instances = v.instances;
    this.geomLength = v.geomLength;
    this.trail = v.trail;
    this.seenEvents = v.seenEvents;
    this.ap = v.ap;
    this.autopilotOn = v.autopilotOn;
    this.landAp = v.landAp;
    this.autoLand = v.autoLand;
    this.manualPitch = v.manualPitch;
    this.stagingEntries = v.stagingEntries;
    this.consumedEntries = v.consumedEntries;
    this.apBtn.textContent = `Autopilot: ${this.autopilotOn ? 'on' : 'off'}`;
    this.streaks.length = 0; // re-seed the motion cues around the new vessel
    this.landingPanelShown = false;
  }

  /**
   * The release: the carrier stages (its sepMass IS the payload's wet
   * mass), the payload spawns as a live vessel seeded at the carrier's
   * state with a small momentum-conserving push-off pair, and control
   * follows the payload — that's the mission. The carrier keeps flying
   * on attitude-hold; switch back with [ or ].
   */
  private releaseVessel(): void {
    const s = this.sim;
    const rel = this.compiled.released?.find((r) => r.sectionBurnIndex === s.stageIndex);
    if (!rel) {
      s.stage();
      return;
    }
    const mSub = massFromStage(rel.sub.vehicle, 0);
    s.stage();
    const rHat = scale(s.state.r, 1 / norm(s.state.r));
    const push = 0.5; // m/s of clean drop separation
    const seed = {
      r: add(s.state.r, scale(rHat, -4)),
      v: add(s.state.v, scale(rHat, -push)),
      theta: s.state.theta,
      omega: 0,
      t: s.state.t,
    };
    s.state.v = add(s.state.v, scale(rHat, (push * mSub) / s.state.m));
    const sim2 = new Sim(rel.sub.vehicle, s.body, undefined, seed);
    sim2.attitude = { mode: 'pitch', angle: this.manualPitch }; // hold the drop attitude
    this.vessels.push({
      name: rel.name,
      sim: sim2,
      compiled: rel.sub,
      instances: buildInstances(rel.sub, rel.subCraft),
      geomLength: rel.sub.geometry.length,
      trail: [],
      lastTrailT: -1,
      seenEvents: 0,
      // A fresh ascent AP is available but OFF — it assumes a pad start.
      ap: new Autopilot(defaultPlan(this.targetAltitude, sim2.body)),
      autopilotOn: false,
      landAp: new LandingAutopilot(),
      autoLand: false,
      manualPitch: this.manualPitch,
      stagingEntries: buildStagingEntries(rel.sub),
      consumedEntries: new Set(),
    });
    this.switchVessel(this.vessels.length - 1);
  }

  /** Stages burning in the current phase (parallel staging: a strap-on
   * phase includes the sustainer and any further strap-on rings). */
  private currentPhaseMembers(): number[] {
    const so = this.sim.vehicle.strapOn;
    const k = this.sim.stageIndex;
    if (!so || !so[k]) return [k];
    const out = [k];
    for (let j = k + 1; j < this.sim.vehicle.stages.length; j++) {
      out.push(j);
      if (!so[j]) break;
    }
    return out;
  }

  /** First staging entry the sim state hasn't already satisfied. */
  private nextStagingIndex(): number {
    for (let i = 0; i < this.stagingEntries.length; i++) {
      if (this.consumedEntries.has(i)) continue;
      const e = this.stagingEntries[i]!;
      if ((e.kind === 'sep' || e.kind === 'release') && this.sim.stageIndex > e.afterStage) continue;
      if (e.kind === 'deploy' && this.sim.deployDone(e.effect!)) continue;
      if (e.kind === 'nozzle' && this.sim.nozzleDeployed.has(e.afterStage)) continue;
      return i;
    }
    return -1;
  }

  private nextStageAction(): void {
    const i = this.nextStagingIndex();
    if (i < 0) {
      this.sim.stage(); // sequence exhausted: raw staging (drops nothing if none left)
      return;
    }
    const e = this.stagingEntries[i]!;
    if (e.kind === 'nozzle') {
      // Only consumable when it actually deploys (engine must be shut
      // down and the stage active) — otherwise leave it queued.
      this.sim.deployNozzle();
      if (this.sim.nozzleDeployed.has(e.afterStage)) this.consumedEntries.add(i);
      return;
    }
    this.consumedEntries.add(i);
    if (e.kind === 'sep') this.sim.stage();
    else if (e.kind === 'release') this.releaseVessel();
    else this.sim.deploy(e.effect!);
  }

  /** Right-drag steering: pitch the commanded attitude in the orbital
   * plane (the sim is 3-DOF planar; steering input maps to in-plane
   * pitch, the one axis that exists). */
  private attachSteering(root: HTMLElement): void {
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    let lastX: number | null = null;
    root.addEventListener('mousedown', (e) => {
      if (e.button === 2) lastX = e.clientX;
    });
    window.addEventListener('mousemove', (e) => {
      if (lastX === null) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      if (this.autopilotOn) this.toggleAutopilot(); // manual takeover
      this.manualPitch = Math.min(Math.PI, Math.max(-Math.PI, this.manualPitch + dx * 0.003));
      this.sim.attitude = { mode: 'pitch', angle: this.manualPitch };
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) lastX = null;
    });
  }

  private toggleAutopilot(): void {
    this.autopilotOn = !this.autopilotOn;
    this.apBtn.textContent = `Autopilot: ${this.autopilotOn ? 'on' : 'off'}`;
    if (!this.autopilotOn) {
      // Take over smoothly at the current commanded pitch.
      const upA = Math.atan2(this.sim.state.r.y, this.sim.state.r.x);
      this.manualPitch = Math.abs(this.sim.targetAngle() - upA);
      this.sim.attitude = { mode: 'pitch', angle: this.manualPitch };
    }
  }

  private setWarp(i: number): void {
    this.warpIndex = Math.min(WARP_STEPS.length - 1, Math.max(0, i));
    this.warpLabel.textContent = `${WARP_STEPS[this.warpIndex]}×`;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      e.preventDefault();
      if (!this.running) this.launch();
      else this.nextStageAction();
    } else if (e.key === '.') this.setWarp(this.warpIndex + 1);
    else if (e.key === ',') this.setWarp(this.warpIndex - 1);
    else if (e.key === 'a') this.toggleAutopilot();
    else if (e.key === 'g') this.sim.deploy(this.compiled.vehicle.gear ? 'gear' : 'legs');
    else if (e.key === '[') this.switchVessel(this.activeIndex - 1);
    else if (e.key === ']') this.switchVessel(this.activeIndex + 1);
    else if (e.key === 'p') this.sim.deployChutes();
    else if (e.key === 't') this.sim.rcsSettle = !this.sim.rcsSettle;
    else if (e.key === 'u') this.sim.fireUllageMotor();
    else if (e.key === 'n') this.sim.deployNozzle();
    else if (!this.autopilotOn) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.manualPitch = Math.min(
          Math.PI,
          Math.max(-Math.PI, this.manualPitch + ((e.key === 'ArrowRight' ? 1 : -1) * Math.PI) / 90),
        );
        this.sim.attitude = { mode: 'pitch', angle: this.manualPitch };
      } else if (e.key === 'ArrowUp') this.sim.throttle = Math.min(1, this.sim.throttle + 0.1);
      else if (e.key === 'ArrowDown') this.sim.throttle = Math.max(0, this.sim.throttle - 0.1);
      else if (e.key === 'z') this.sim.throttle = 1;
      else if (e.key === 'x') this.sim.throttle = 0;
    }
  };

  // ---------- loop ----------

  private frame = (now: number): void => {
    const wallDt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.lastWallDt = wallDt;
    const s = this.sim;
    const atmTop = s.body.atmosphere?.topAltitude ?? 0;

    if (this.running) {
      // Make sure the active bundle aliases the live working set before
      // stepping through the array (vessels[active].sim === this.sim).
      this.syncActive();
      let toAdvance = wallDt * WARP_STEPS[this.warpIndex]!;
      let ticks = 0;
      while (toAdvance > 1e-9 && ticks < 2000) {
        if (!s.crashed) {
          if (this.autopilotOn) this.ap.update(s);
          else if (this.autoLand) this.landAp.update(s);
        }
        // Warp is global: the shared per-tick dt is the strictest regime
        // clamp over EVERY vessel (the coasting fast-path only when all
        // coast). Step order is the fixed array order — deterministic.
        let coastingAll = true;
        for (const v of this.vessels) {
          const vs = v.sim;
          if (vs.crashed) continue;
          const top = vs.body.atmosphere?.topAltitude ?? 0;
          if (!(!vs.burning && vs.actualThrottle < 0.01 && vs.altitude > top)) coastingAll = false;
        }
        const dt = Math.min(toAdvance, coastingAll ? Math.max(1, toAdvance / 4) : 0.25);
        for (const v of this.vessels) {
          if (v.sim.crashed) continue;
          v.sim.step(dt);
          if (v.sim.state.t - v.lastTrailT > 0.5) {
            v.lastTrailT = v.sim.state.t;
            v.trail.push({ x: v.sim.state.r.x, y: v.sim.state.r.y, t: v.sim.state.t });
            if (v.trail.length > 4000) v.trail.splice(0, 1000);
          }
        }
        toAdvance -= dt;
        ticks++;
      }
    }

    this.pumpEvents();
    if (++this.frameCount % 15 === 0) this.updateImpactPrediction();
    const pRatio = s.body.atmosphere ? s.body.atmosphere.pressure(Math.max(0, s.altitude)) / P0_SEA_LEVEL : 0;
    this.draw(pRatio);
    this.updateHud();
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * Impact predictor: forward-integrate the current state (no thrust,
   * current drag config incl. deployed chutes) until it meets the surface.
   * Runs every 15th frame; a few hundred coarse RK2 steps is plenty.
   */
  private updateImpactPrediction(): void {
    const s = this.sim;
    this.impact = null;
    if (!this.running || s.landed || s.crashed || s.hasLanded) return;
    const el = s.elements;
    if (el.e < 1 && el.rPeri > s.body.radius) return; // not coming down
    if (s.altitude > 400_000) return;
    const atm = s.body.atmosphere;
    const mu = s.body.mu;
    const R = s.body.radius;
    const rot = s.body.rotationRate;
    const cdA0 = s.vehicle.cd * s.vehicle.area;
    const chuteA = s.activeChutes().reduce((sum, c) => sum + c.cdA, 0);
    let r = { ...s.state.r };
    let v = { ...s.state.v };
    const m = s.state.m;
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      const rn = norm(r);
      const alt = rn - R;
      if (alt <= 0) {
        this.impact = { angle: Math.atan2(r.y, r.x), dt: t };
        return;
      }
      const vr = (r.x * v.x + r.y * v.y) / rn;
      const dt = Math.max(0.25, Math.min(6, alt / (2 * Math.abs(vr) + 20)));
      // RK2 midpoint with gravity + drag (prediction, not simulation).
      const accAt = (rr: typeof r, vv: typeof v) => {
        const rrn = norm(rr);
        let a = scale(rr, -mu / (rrn * rrn * rrn));
        const h = rrn - R;
        if (atm && h < atm.topAltitude) {
          const air = sub(vv, scale(perp(rr), rot));
          const speed = norm(air);
          if (speed > 0.1) {
            const q = 0.5 * atm.density(Math.max(0, h)) * speed * speed;
            const cdA = cdA0 * machDragFactor(speed / speedOfSound(Math.max(0, h))) + chuteA;
            a = add(a, scale(air, (-q * cdA) / (speed * m)));
          }
        }
        return a;
      };
      const a1 = accAt(r, v);
      const rm = add(r, scale(v, dt / 2));
      const vm = add(v, scale(a1, dt / 2));
      const a2 = accAt(rm, vm);
      r = add(r, scale(vm, dt));
      v = add(v, scale(a2, dt));
      t += dt;
      if (t > 3_600) return; // not impacting within the hour
    }
  }

  private pumpEvents(): void {
    // Every vessel's events reach the feed; background lines carry the
    // vessel's name so a "[Carrier] Landed" is legible mid-mission.
    this.syncActive();
    this.vessels.forEach((v, i) => {
      v.seenEvents = this.pumpVesselEvents(v, i === this.activeIndex ? '' : `[${v.name}] `);
    });
    this.seenEvents = this.vessels[this.activeIndex]!.seenEvents;
  }

  private pumpVesselEvents(v: Vessel, prefix: string): number {
    const evs = v.sim.events;
    let seen = v.seenEvents;
    for (; seen < evs.length; seen++) {
      const ev = evs[seen]!;
      let text = '';
      switch (ev.type) {
        case 'liftoff':
          text = 'Liftoff';
          break;
        case 'stageBurnout':
          text = `Stage ${ev.stage + 1} burnout`;
          break;
        case 'stageSeparation':
          text = `Stage ${ev.stage + 1} separation`;
          break;
        case 'partTorn':
          text = `⚠ ${ev.partName} torn off — dynamic pressure`;
          break;
        case 'breakup':
          text = `Vehicle destroyed — q = ${(ev.q / 1000).toFixed(0)} kPa`;
          break;
        case 'orbit':
          text = 'Orbit achieved';
          break;
        case 'crash':
          text = `Impact at ${fmtSpeed(ev.speed)}`;
          break;
        case 'flameout':
          text = `⚠ Flameout — propellant unsettled (ignition spent). Settle with RCS (T) or an ullage motor (U), then relight`;
          break;
        case 'jetFlameout':
          text = `⚠ Jet flameout — ${ev.reason}`;
          break;
        case 'gearDeployed':
          text = 'Landing gear down';
          break;
        case 'gearRetracted':
          text = 'Landing gear up';
          break;
        case 'engineDestroyed':
          text = `✗ Stage ${ev.stage + 1} engines destroyed — ${ev.reason}`;
          break;
        case 'fairingJettisoned':
          text = 'Fairing jettisoned';
          break;
        case 'nozzleDeployed':
          text = `Nozzle extension deployed (stage ${ev.stage + 1})`;
          break;
        case 'ullageMotorFired':
          text = `Ullage motor fired — ${ev.remaining} left`;
          break;
        case 'ignitionFailed':
          text = `⚠ Stage ${ev.stage + 1}: no ignitions left (${ev.limit} used, limit ${ev.limit})`;
          break;
        case 'soiTransition': {
          const to = bodyById(ev.to);
          text = `Entered the ${to.name} sphere of influence`;
          // Convert the trail to the new reference frame: each point moves
          // by the child body's ephemeris offset at its own recorded time,
          // giving the historical body-relative path.
          const child = to.parent === ev.from ? to : bodyById(ev.from);
          const sign = to.parent === ev.from ? -1 : 1;
          for (const p of v.trail) {
            const eph = bodyOrbitState(child, p.t);
            p.x += sign * eph.r.x;
            p.y += sign * eph.r.y;
          }
          break;
        }
      }
      if (!text) continue; // events without feed copy (gear/legs handled by rows)
      const div = document.createElement('div');
      div.textContent = `T+${fmtTime(ev.t)}  ${prefix}${text}`;
      this.feed.prepend(div);
      while (this.feed.children.length > 5) this.feed.lastChild?.remove();
    }
    return seen;
  }

  // ---------- rendering ----------

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.root.clientWidth * dpr;
    this.canvas.height = this.root.clientHeight * dpr;
    this.canvas.style.width = `${this.root.clientWidth}px`;
    this.canvas.style.height = `${this.root.clientHeight}px`;
  }

  /** Sim plane → 3D world: the launch site (sim +x) is the top of the
   * sphere so local vertical reads as screen-up; sim +y (downrange east)
   * maps to world +x. (A mirror of the plane — visual only.) */
  private toWorld(x: number, y: number): { x: number; y: number; z: number } {
    return { x: y, y: x, z: 0 };
  }

  private draw(pRatio: number): void {
    const s = this.sim;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const rocketW = this.toWorld(s.state.r.x, s.state.r.y);
    this.camera.target = v3(rocketW.x, rocketW.y, rocketW.z);

    const near = Math.max(0.5, this.camera.dist * 0.02);
    const far = Math.max(1e5, this.camera.dist * 40 + 2 * s.body.radius + 8e8);
    // Sky: blends from ground blue through stratospheric dark to space
    // black as the vehicle climbs out of the atmosphere. Airless bodies
    // get a black sky at any altitude.
    const skyF = s.body.atmosphere ? Math.pow(Math.max(0, 1 - s.altitude / 75_000), 1.6) : 0;
    const clear: [number, number, number] = [
      0.01 + 0.33 * skyF,
      0.012 + 0.5 * skyF,
      0.03 + 0.72 * skyF,
    ];
    this.renderer.begin(this.camera.proj(w / h, near, far), this.camera.viewRot(), this.camera.eye(), clear);

    // Planet: terrain-colored sphere rotating with the body (β = −ωt under
    // the plane mapping), plus haze shells at the USSA76 layer scales.
    const spin = rotationZ(-s.body.rotationRate * s.state.t);
    // depthPush: the sphere's model origin is the body center, so its MVP
    // jitters ~0.5 m at Earth scale in float32 — push it behind the pad
    // and the local ground cap instead of letting them z-fight (the
    // "flashing ground at launch" bug).
    const planetMesh = s.body.id === 'moon' ? 'planet-moon' : 'planet-earth';
    // While the local ground cap is active, cut the global sphere's
    // near-field out entirely in the shader (uHole): its planet-center
    // model origin jitters in float32 up close, and no polygon offset can
    // fully mask two surfaces a jitter apart — remove the competition.
    const capActive = s.altitude < 30_000;
    const upA0 = Math.atan2(s.state.r.y, s.state.r.x);
    const capW0 = this.toWorld(s.body.radius * Math.cos(upA0), s.body.radius * Math.sin(upA0));
    this.renderer.draw(
      planetMesh,
      multiply(spin, scaling(s.body.radius)),
      [1, 1, 1],
      1,
      false,
      false,
      true,
      capActive ? { x: capW0.x, y: capW0.y, z: capW0.z, r: 55_000 } : undefined,
    );
    // Local terrain cap anchored at the sub-vehicle surface point: its
    // camera-relative translation is small, so the ground the player
    // actually looks at is depth-stable.
    if (capActive) {
      const upA = upA0;
      const capW = capW0;
      // Tint from the body's paint at the sub-vehicle point (sim plane =
      // equator, lat 0; the launch site sits at longitude 90°).
      const lon = Math.PI / 2 - upA + s.body.rotationRate * s.state.t;
      const tint = s.body.id === 'moon' ? moonColor(0, lon) : terrainColor(0, lon);
      this.renderer.draw(
        `cap-${s.body.id}`,
        multiply(translation(capW.x, capW.y, capW.z), rotationZ(-upA)),
        tint,
      );
    }
    if (s.body.atmosphere) {
      this.renderer.draw('shell', scaling(s.body.radius + 12_000), [0.55, 0.7, 0.9], 0.1);
      this.renderer.draw('shell', scaling(s.body.radius + 45_000), [0.4, 0.6, 0.95], 0.07);
      this.renderer.draw('shell', scaling(s.body.radius + 90_000), [0.3, 0.5, 0.95], 0.05);
    }

    // Child bodies on their real orbits (same ephemeris the sim's SOI
    // logic uses), and the parent body when the reference is a moon.
    for (const b of BODIES) {
      if (b.parent !== s.body.id || !b.orbit) continue;
      const eph = bodyOrbitState(b, s.state.t);
      const bw = this.toWorld(eph.r.x, eph.r.y);
      const bMesh = b.id === 'moon' ? 'planet-moon' : 'planet-earth';
      const bSpin = rotationZ(-b.rotationRate * s.state.t);
      this.renderer.draw(
        bMesh,
        multiply(multiply(translation(bw.x, bw.y, bw.z), bSpin), scaling(b.radius)),
        [1, 1, 1],
      );
    }
    if (s.body.parent) {
      const parent = bodyById(s.body.parent);
      const eph = bodyOrbitState(s.body, s.state.t);
      const pw = this.toWorld(-eph.r.x, -eph.r.y);
      const pMesh = parent.id === 'moon' ? 'planet-moon' : 'planet-earth';
      const pSpin = rotationZ(-parent.rotationRate * s.state.t);
      this.renderer.draw(
        pMesh,
        multiply(multiply(translation(pw.x, pw.y, pw.z), pSpin), scaling(parent.radius)),
        [1, 1, 1],
      );
    }

    // Launch pad (rotates with the body): a platform up close, a beacon
    // cone when zoomed out to map scales. The pad is the Earth launch
    // site — not drawn when another body is the reference.
    if (s.body.id === 'earth') {
      const padA = s.body.rotationRate * s.state.t;
      const padW = this.toWorld(s.body.radius * Math.cos(padA), s.body.radius * Math.sin(padA));
      if (this.camera.dist < 3_000) {
        const padModel = multiply(
          multiply(translation(padW.x, padW.y, padW.z), rotationZ(-padA)),
          scalingXYZ(22, 0.4, 22),
        );
        this.renderer.draw('padDisc', padModel, [0.3, 0.32, 0.36]);
      } else {
        const padScale = this.camera.dist * 0.012;
        this.renderer.draw(
          'pad',
          multiply(translation(padW.x, padW.y, padW.z), scaling(padScale)),
          [1.0, 0.78, 0.34],
          1,
          true,
        );
      }
    }

    // Runways (rotate with the body): a 4 km asphalt strip along the
    // surface tangent up close, a cyan beacon at map scales.
    for (const site of SITES) {
      if (site.type !== 'runway' || site.body !== s.body.id) continue;
      const a = site.angle + s.body.rotationRate * s.state.t;
      const w = this.toWorld(s.body.radius * Math.cos(a), s.body.radius * Math.sin(a));
      if (this.camera.dist < 30_000) {
        const model = multiply(
          multiply(translation(w.x, w.y, w.z), rotationZ(a + Math.PI / 2)),
          scalingXYZ(site.halfLength ?? 2_000, 0.3, 15),
        );
        this.renderer.draw('padDisc', model, [0.2, 0.21, 0.24]);
      } else {
        const bScale = this.camera.dist * 0.012;
        this.renderer.draw('pad', multiply(translation(w.x, w.y, w.z), scaling(bScale)), [0.4, 0.8, 1.0], 1, true);
      }
    }

    // Orbit line + trail, rebased to the vehicle for float precision.
    // Elliptic: the full conic. Hyperbolic (e.g. a lunar flyby leg): the
    // arc between asymptotes, clipped to the reference body's SOI scale.
    const el = s.elements;
    if ((el.e < 1 && el.rApo > s.body.radius * 0.5) || (el.e >= 1 && !s.landed)) {
      const p = el.a * (1 - el.e * el.e);
      const rMax = Math.min(isFinite(s.body.soi) ? s.body.soi * 1.05 : Infinity, Math.abs(el.a) * 40 + 1e9);
      let nuMax = Math.PI;
      if (el.e >= 1) {
        // True anomaly of the asymptote, backed off; also clip to rMax.
        const nuAsym = Math.acos(-1 / el.e);
        const cosClip = (p / rMax - 1) / el.e;
        nuMax = Math.min(nuAsym - 0.02, Math.acos(Math.max(-1, Math.min(1, cosClip))));
      }
      const pts = new Float32Array(129 * 3);
      for (let i = 0; i <= 128; i++) {
        const nu = -nuMax + (i / 128) * 2 * nuMax;
        const rad = p / (1 + el.e * Math.cos(nu));
        const ang = el.argPeri + (el.h >= 0 ? nu : -nu);
        const wpt = this.toWorld(rad * Math.cos(ang), rad * Math.sin(ang));
        pts[i * 3] = wpt.x - rocketW.x;
        pts[i * 3 + 1] = wpt.y - rocketW.y;
        pts[i * 3 + 2] = wpt.z - rocketW.z;
      }
      this.renderer.updateLines('orbit', pts);
      this.renderer.draw(
        'orbit',
        translation(rocketW.x, rocketW.y, rocketW.z),
        s.inOrbit ? [0.35, 0.85, 0.55] : [0.45, 0.65, 0.95],
        0.9,
        true,
      );
    }
    if (this.trail.length > 1) {
      const pts = new Float32Array(this.trail.length * 3);
      for (let i = 0; i < this.trail.length; i++) {
        const wpt = this.toWorld(this.trail[i]!.x, this.trail[i]!.y);
        pts[i * 3] = wpt.x - rocketW.x;
        pts[i * 3 + 1] = wpt.y - rocketW.y;
        pts[i * 3 + 2] = wpt.z - rocketW.z;
      }
      this.renderer.updateLines('trail', pts);
      this.renderer.draw('trail', translation(rocketW.x, rocketW.y, rocketW.z), [0.55, 0.6, 0.75], 0.5, true);
    }

    // The vehicle: actual part meshes at the simulated attitude. The sim's
    // point mass is the CoM; the stack is offset so the CoM sits at r.
    // Body axis (cos θ, sin θ) in the sim plane → world: local +y of the
    // part stack rotated by rotationZ(−θ) under the plane mapping above.
    const yCoM = s.massProps.yCoM;
    const att = multiply(
      translation(rocketW.x, rocketW.y, rocketW.z),
      rotationZ(-s.state.theta),
    );
    for (const inst of this.instances) {
      if (inst.burnIndex < s.stageIndex || s.torn.has(inst.partId)) continue;
      let local = multiply(translation(inst.x, inst.y - yCoM, inst.z), rotationY(-inst.angle));
      if (inst.hScale !== 1) local = multiply(local, scalingXYZ(1, inst.hScale, 1));
      // Deployed legs splay outward, pivoting at the strut top.
      if (inst.isLeg && s.legsDeployed) {
        const pivot = multiply(
          multiply(translation(0, inst.height, 0), rotationZ(-(50 * Math.PI) / 180)),
          translation(0, -inst.height, 0),
        );
        local = multiply(local, pivot);
      }
      this.renderer.draw(inst.defId, multiply(att, local), inst.color);

      // Plume: expansion tracks the nozzle/ambient pressure match —
      // over- and under-expansion visibly change the exhaust, and a
      // mismatched nozzle shows a shock-diamond train. The plume telling
      // you the engine is wrong for this altitude IS the instrumentation.
      const phaseMembers = this.currentPhaseMembers();
      if (
        inst.engine &&
        phaseMembers.includes(inst.burnIndex) &&
        !s.engineFailed.has(inst.burnIndex) &&
        s.actualThrottle > 0.02 &&
        !s.crashed
      ) {
        const pAmb = pRatio * P0_SEA_LEVEL;
        const match = inst.pExit / Math.max(pAmb, 8); // >1 = underexpanded
        const widen = Math.min(3.2, Math.max(0.7, Math.sqrt(match)));
        const len =
          inst.exitRadius * 9 * s.actualThrottle * (0.92 + Math.random() * 0.16) *
          Math.min(1.8, Math.max(0.8, Math.cbrt(match)));
        const plumeLocal = multiply(
          translation(inst.x, inst.y - yCoM, inst.z),
          scalingXYZ(inst.exitRadius * widen, len, inst.exitRadius * widen),
        );
        this.renderer.draw('plume', multiply(att, plumeLocal), [1.0, 0.72, 0.35], 0.65, true);
        if (pAmb > 300 && (match < 0.55 || match > 2.5)) {
          const spacing = inst.exitRadius * (1.1 + Math.min(2.5, Math.abs(Math.log(match))));
          for (let k = 1; k <= 3; k++) {
            const dLocal = multiply(
              translation(inst.x, inst.y - yCoM - k * spacing, inst.z),
              scaling(inst.exitRadius * 0.34),
            );
            this.renderer.draw('canopy', multiply(att, dLocal), [1.0, 0.92, 0.75], 0.8, true);
          }
        }
      }
    }

    // Deployed parachute canopies above the stack.
    for (const c of s.activeChutes()) {
      const r = Math.min(14, Math.max(2.5, Math.sqrt(c.cdA) / 3));
      const canopyLocal = multiply(
        translation(0, c.y - yCoM + r * 1.9, 0),
        scalingXYZ(r, r * 0.55, r),
      );
      this.renderer.draw('canopy', multiply(att, canopyLocal), [0.9, 0.45, 0.2], 0.92);
    }

    // Background vessels: parts, a simple plume, and their own trails.
    // Each is anchored to its OWN world position — the float64 rule:
    // never draw one vessel's near-field geometry relative to another's
    // origin. Streaks/arrows/impact markers stay active-only.
    this.vessels.forEach((v, vi) => {
      if (vi === this.activeIndex) return;
      const bs = v.sim;
      if (bs.body.id !== s.body.id) return; // cross-frame fallback: skip drawing
      const w = this.toWorld(bs.state.r.x, bs.state.r.y);
      const yC = bs.massProps.yCoM;
      const attB = multiply(translation(w.x, w.y, w.z), rotationZ(-bs.state.theta));
      for (const inst of v.instances) {
        if (inst.burnIndex < bs.stageIndex || bs.torn.has(inst.partId)) continue;
        let local = multiply(translation(inst.x, inst.y - yC, inst.z), rotationY(-inst.angle));
        if (inst.hScale !== 1) local = multiply(local, scalingXYZ(1, inst.hScale, 1));
        this.renderer.draw(inst.defId, multiply(attB, local), inst.color);
        if (inst.engine && inst.burnIndex === bs.stageIndex && bs.actualThrottle > 0.02 && !bs.crashed) {
          const plumeLocal = multiply(
            translation(inst.x, inst.y - yC, inst.z),
            scalingXYZ(inst.exitRadius, inst.exitRadius * 8 * bs.actualThrottle, inst.exitRadius),
          );
          this.renderer.draw('plume', multiply(attB, plumeLocal), [1.0, 0.72, 0.35], 0.6, true);
        }
      }
      if (v.trail.length > 1) {
        const pts = new Float32Array(v.trail.length * 3);
        for (let k = 0; k < v.trail.length; k++) {
          const wpt = this.toWorld(v.trail[k]!.x, v.trail[k]!.y);
          pts[k * 3] = wpt.x - w.x;
          pts[k * 3 + 1] = wpt.y - w.y;
          pts[k * 3 + 2] = wpt.z - w.z;
        }
        this.renderer.updateLines(`trail-v${vi}`, pts);
        this.renderer.draw(`trail-v${vi}`, translation(w.x, w.y, w.z), [0.7, 0.58, 0.42], 0.5, true);
      }
    });

    // Steering indicators: commanded attitude (cyan) and airspeed (green).
    if (this.running && !s.landed && !s.crashed) {
      const L = this.geomLength * 1.1;
      const tgt = s.targetAngle();
      const tgtM = multiply(
        translation(rocketW.x, rocketW.y, rocketW.z),
        multiply(rotationZ(-tgt), scalingXYZ(1, L, 1)),
      );
      this.renderer.draw('arrow', tgtM, [0.4, 0.85, 1.0], 0.55, true);
      const air = s.airspeedVec;
      if (norm(air) > 2) {
        const airA = Math.atan2(air.y, air.x);
        const airM = multiply(
          translation(rocketW.x, rocketW.y, rocketW.z),
          multiply(rotationZ(-airA), scalingXYZ(1, L * 0.85, 1)),
        );
        this.renderer.draw('arrow', airM, [0.45, 0.95, 0.55], 0.45, true);
      }
    }

    // ---- Motion cues (render-only; the sim never sees these) ----
    // Airflow streaks: parcels streaming past the vehicle opposite the
    // airspeed vector — without them fast flight and falls read as static
    // because the surrounding sky/ground are featureless.
    const airVec = s.airspeedVec;
    const airSpeed = norm(airVec);
    if (this.running && !s.crashed && s.body.atmosphere && s.altitude < s.body.atmosphere.topAltitude && airSpeed > 60) {
      const range = Math.max(80, this.geomLength * 5);
      if (this.streaks.length === 0) {
        for (let i = 0; i < 70; i++) {
          this.streaks.push({
            x: (Math.random() * 2 - 1) * range,
            y: (Math.random() * 2 - 1) * range,
            z: (Math.random() * 2 - 1) * range * 0.5,
          });
        }
      }
      // World-space flow: air moves past the vehicle at −airspeed.
      const dW = this.toWorld(airVec.x, airVec.y);
      const inv = 1 / airSpeed;
      const dir = { x: dW.x * inv, y: dW.y * inv, z: 0 };
      // Advect at a readability-capped speed so streaks persist a few
      // frames even at km/s; their LENGTH carries the speed cue instead.
      const adv = Math.min(airSpeed, range * 4) * this.lastWallDt;
      const len = Math.min(range * 0.6, 3 + airSpeed * 0.04);
      const pts = new Float32Array(this.streaks.length * 6);
      for (let i = 0; i < this.streaks.length; i++) {
        const p = this.streaks[i]!;
        p.x -= dir.x * adv;
        p.y -= dir.y * adv;
        if (p.x * p.x + p.y * p.y + p.z * p.z > range * range) {
          // Respawn upstream in a disc perpendicular-ish to the flow.
          p.x = dir.x * range * 0.85 + (Math.random() * 2 - 1) * range * 0.6;
          p.y = dir.y * range * 0.85 + (Math.random() * 2 - 1) * range * 0.6;
          p.z = (Math.random() * 2 - 1) * range * 0.5;
        }
        pts[i * 6] = p.x;
        pts[i * 6 + 1] = p.y;
        pts[i * 6 + 2] = p.z;
        pts[i * 6 + 3] = p.x - dir.x * len;
        pts[i * 6 + 4] = p.y - dir.y * len;
        pts[i * 6 + 5] = p.z;
      }
      this.renderer.updateLines('streaks', pts, true);
      const alpha = Math.min(0.45, 0.08 + s.q / 40_000);
      this.renderer.draw('streaks', translation(rocketW.x, rocketW.y, rocketW.z), [0.85, 0.92, 1.0], alpha, true);

      // Compression glow: Sutton–Graves stagnation heating scales with
      // √ρ·v³ — used here purely as a visual threshold/intensity, drawn
      // as a hot sheath on the windward side.
      const rho = s.body.atmosphere.density(Math.max(0, s.altitude));
      const heat = Math.sqrt(rho) * airSpeed ** 3;
      if (heat > 5e8) {
        const a = Math.min(0.55, (heat - 5e8) / 5e9);
        const airA = Math.atan2(airVec.y, airVec.x);
        const gw = Math.max(2.5, this.geomLength * 0.22) * (1 + 0.1 * Math.random());
        const glowLocal = multiply(
          multiply(rotationZ(-airA), translation(0, this.geomLength * 0.18, 0)),
          scalingXYZ(gw, this.geomLength * 0.8, gw),
        );
        this.renderer.draw(
          'shell',
          multiply(translation(rocketW.x, rocketW.y, rocketW.z), glowLocal),
          [1.0, 0.55, 0.22],
          a,
          true,
        );
      }
    } else if (this.streaks.length > 0) {
      this.streaks.length = 0;
    }

    // Impact predictor marker.
    if (this.impact) {
      const iw = this.toWorld(
        s.body.radius * Math.cos(this.impact.angle),
        s.body.radius * Math.sin(this.impact.angle),
      );
      const sc = Math.max(8, this.camera.dist * 0.014);
      this.renderer.draw(
        'pad',
        multiply(translation(iw.x, iw.y, iw.z), scaling(sc)),
        [1.0, 0.3, 0.3],
        0.95,
        true,
        true,
      );
    }
  }

  // ---------- HUD ----------

  private set(key: string, text: string, cls = ''): void {
    // Rows are built per-craft (plane rows, vessel row) — a vessel switch
    // can land on a HUD without this key; skip rather than throw.
    const el = this.hudValues.get(key);
    if (!el) return;
    el.textContent = text;
    el.className = `value ${cls}`;
  }

  private updateHud(): void {
    const s = this.sim;
    const el = s.elements;
    const atmTop = s.body.atmosphere?.topAltitude ?? 0;
    const stage = s.vehicle.stages[s.stageIndex];
    this.set('met', `T+ ${fmtTime(s.state.t)}`);
    this.set('phase', s.crashed ? 'LOST' : this.autopilotOn ? this.ap.phase : 'manual');
    if (this.vessels.length > 1) {
      this.set('vessel', `${this.activeIndex + 1}/${this.vessels.length} ${this.vessels[this.activeIndex]!.name} ([ ])`);
    } else {
      this.set('vessel', this.vessels[0]?.name ?? '—');
    }
    this.set('refbody', s.body.name, s.body.id === 'earth' ? '' : 'good');
    this.set('alt', fmtDistance(s.altitude));
    this.set('air', fmtSpeed(norm(s.airspeedVec)));
    this.set('orb', fmtSpeed(norm(s.state.v)));
    const apAlt = el.rApo - s.body.radius;
    const peAlt = el.rPeri - s.body.radius;
    this.set('ap', el.e >= 1 ? 'escape' : fmtDistance(apAlt), apAlt > this.targetAltitude * 0.98 ? 'good' : '');
    this.set('pe', fmtDistance(peAlt), peAlt > atmTop ? 'good' : peAlt > 0 ? 'warn' : 'bad');
    this.set('tapo', fmtTime(el.timeToApo));

    const props = s.massProps;
    const surfaceG = s.body.mu / (s.body.radius * s.body.radius);
    let twr = 0;
    if (stage && s.actualThrottle > 0) {
      if (stage.engines.some((g) => g.engine.airBreathing)) {
        // Jets: thrust is T(M, ρ) — the sim's live readout is the truth.
        twr = s.thrustNow / (s.state.m * surfaceG);
      } else {
        // Display TWR from current acceleration capability at the local
        // ambient pressure — vacuum thrust overstates it at sea level.
        const p = s.body.atmosphere?.pressure(Math.max(0, s.altitude)) ?? 0;
        twr = (s.actualThrottle * stageThrustAtPressure(stage, p)) / (s.state.m * surfaceG);
      }
    }
    this.set('twr', twr.toFixed(2), twr > 0 && twr < 1 ? 'warn' : '');
    this.set('throttle', `${Math.round(s.throttle * 100)} % → ${Math.round(s.actualThrottle * 100)} %`);
    if (this.autopilotOn) this.throttleSlider.value = String(Math.round(s.throttle * 100));
    this.set('q', `${(s.q / 1000).toFixed(1)} kPa`, s.q > 60_000 ? 'warn' : '');
    this.set('mach', s.mach > 0.05 ? s.mach.toFixed(2) : '—', s.mach > 0.85 && s.mach < 1.3 ? 'warn' : '');
    this.set('aoa', `${((s.aoa * 180) / Math.PI).toFixed(1)}°`, Math.abs(s.aoa) > 0.15 && s.q > 5_000 ? 'warn' : '');
    const pa = this.compiled.vehicle.planeAero;
    if (pa) {
      // Plane class: %MAC + stall margin + elevator — never calibers.
      if (pa.surfaces.length > 0) {
        const st = planeStability(props, this.compiled.geometry.refArea, pa);
        this.set(
          'margin',
          isNaN(st.staticMarginPctMAC) ? '—' : `${st.staticMarginPctMAC.toFixed(0)}% MAC`,
          s.q > 500 ? (st.staticMarginPctMAC >= 3 ? 'good' : st.staticMarginPctMAC >= 0 ? 'warn' : 'bad') : '',
        );
        const smDeg = (s.stallMargin * 180) / Math.PI;
        this.set(
          'stall',
          s.stalled ? 'STALL' : isFinite(smDeg) ? `${smDeg.toFixed(1)}°` : '—',
          s.stalled ? 'bad' : smDeg < 5 && s.q > 500 ? 'warn' : '',
        );
        this.set('trim', `δe ${((s.elevator * 180) / Math.PI).toFixed(1)}°`,
          Math.abs(s.elevator) > 0.8 * pa.elevMax ? 'warn' : '');
      } else {
        this.set('margin', 'no wings', 'warn');
        this.set('stall', '—');
        this.set('trim', '—');
      }
    } else {
      const margin = props.staticMarginCal;
      this.set(
        'margin',
        props.cnAlpha > 0 ? `${margin.toFixed(1)} cal` : '—',
        s.q > 1_000 ? (margin >= 0.2 ? 'good' : margin >= 0 ? 'warn' : 'bad') : '',
      );
    }
    this.set('gimbal', `${((s.gimbal * 180) / Math.PI).toFixed(1)}°`);
    // Ullage state: pump-fed relights need settled propellant.
    const settleTxt = s.settled
      ? s.rcsSettle && !s.landed
        ? 'settled (RCS holding)'
        : 'settled'
      : s.rcsSettle
        ? 'settling…'
        : 'UNSETTLED';
    this.set('settle', settleTxt, s.settled ? 'good' : 'warn');
    this.set(
      'rcs',
      `${isFinite(s.rcsPropellant) ? s.rcsPropellant.toFixed(0) + ' kg' : '—'}${s.ullageMotorsLeft > 0 ? ` · ${s.ullageMotorsLeft} motor${s.ullageMotorsLeft > 1 ? 's' : ''} (U)` : ''}`,
    );

    // Stage button shows the next sequence action, KSP-style.
    const nextIdx = this.nextStagingIndex();
    this.stageBtn.textContent =
      nextIdx >= 0 ? `${this.stagingEntries[nextIdx]!.label} (space)` : 'Stage (space)';

    if (stage) {
      const full = stage.tanks.reduce((sum, t) => sum + t.propellantMass, 0);
      // Ignition budget and throttle floor, when the engines have either.
      const ignLimit = stageIgnitionLimit(stage);
      const floor = stageMinThrottle(stage);
      const extras = [
        isFinite(ignLimit) ? `ign ${s.ignitionsUsed[s.stageIndex] ?? 0}/${ignLimit}` : '',
        floor > 0 && floor < 1 ? `min thr ${Math.round(floor * 100)}%` : floor >= 1 ? 'fixed thrust' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      this.set('prop', `Stage ${s.stageIndex + 1}: ${fmtMass(s.propellant)}${extras ? ` · ${extras}` : ''}`);
      this.propFill.style.width = full > 0 ? `${(100 * s.propellant) / full}%` : '0%';
    } else {
      this.set('prop', 'no stages left');
      this.propFill.style.width = '0%';
    }

    // Landing panel: live during descent (or auto-land), with per-limit
    // margin coloring against the active touchdown mode. Hysteresis so a
    // hover with vSpeed oscillating around 0 doesn't flicker the panel:
    // appears when clearly descending, hides only when clearly climbing.
    if (!this.landingPanelShown) {
      if (this.running && !s.landed && s.vSpeed > 0.5 && s.altitude < 20_000) {
        this.landingPanelShown = true;
      }
    } else if (s.vSpeed < -2 || s.altitude >= 22_000 || (s.landed && !s.hasLanded)) {
      this.landingPanelShown = false;
    }
    if (this.landingPanelShown || this.autoLand || s.hasLanded) {
      this.landingPanel.style.display = 'block';
      const mode = s.legFootprint() > 0 ? 'legs' : s.activeChutes().length > 0 ? 'chute' : 'none';
      const lim = TOUCHDOWN_LIMITS[mode];
      const radar = s.radarAltitude;
      this.set('radar', fmtDistance(Math.max(0, radar)));
      this.set('vspd', `${s.vSpeed.toFixed(1)} m/s`, s.vSpeed > lim.vSpeed ? 'bad' : s.vSpeed > lim.vSpeed * 0.7 ? 'warn' : 'good');
      this.set('hspd', `${s.hSpeed.toFixed(1)} m/s`, s.hSpeed > lim.hSpeed ? 'bad' : s.hSpeed > lim.hSpeed * 0.7 ? 'warn' : 'good');
      const tiltDeg = (s.tilt * 180) / Math.PI;
      const tiltLim = (lim.tilt * 180) / Math.PI;
      this.set('ltilt', `${tiltDeg.toFixed(1)}°`, tiltDeg > tiltLim ? 'bad' : tiltDeg > tiltLim * 0.7 ? 'warn' : 'good');
      const hBurn = s.suicideBurnAltitude;
      this.set(
        'burnalt',
        isFinite(hBurn) ? fmtDistance(hBurn) : '—',
        isFinite(hBurn) && radar < hBurn * 1.15 ? (radar < hBurn ? 'bad' : 'warn') : '',
      );
      this.set('impact', this.impact ? fmtTime(this.impact.dt) : '—');
      if (this.compiled.vehicle.gear) {
        this.set('gear', s.gearFailed ? 'gear TORN OFF' : s.gearDeployed ? 'gear down ✓' : 'gear UP',
          s.gearFailed ? 'bad' : s.gearDeployed ? 'good' : 'warn');
      } else {
        this.set(
          'gear',
          `${s.legFootprint() > 0 ? 'legs ✓' : this.sim.legsDeployed ? 'no legs' : 'stowed'} · ${
            s.activeChutes().length > 0 ? 'chute ✓' : 'no chute'
          }`,
        );
      }
    } else {
      this.landingPanel.style.display = 'none';
    }

    if (s.crashed) {
      const failEv = this.sim.events.find((e) => e.type === 'landingFailed');
      this.showBanner(
        failEv ? 'Landing failed' : this.sim.events.some((e) => e.type === 'breakup') ? 'Breakup' : 'Crashed',
        'crash',
      );
    } else if (s.hasLanded) this.showBanner('Landed', 'orbit');
    else if (s.inOrbit) this.showBanner('Orbit', 'orbit');
    // Hide a stale banner when its condition lapses (e.g. inOrbit is
    // reset by an SOI transition — the old conic no longer exists).
    else this.banner.style.display = 'none';
  }

  private showBanner(text: string, cls: string): void {
    this.banner.textContent = text;
    this.banner.className = `banner ${cls}`;
    this.banner.style.display = 'block';
  }
}


/** Flatten a compiled craft into renderable part instances. */
function buildInstances(compiled: Compiled, craft: Craft): PartInstance[] {
  const burnIndex = new Map<string, number>();
  compiled.stages.forEach((cs, i) => cs.partIds.forEach((id) => burnIndex.set(id, i)));
  const out: PartInstance[] = [];
  for (const [id, pl] of placements(craft)) {
    for (const inst of pl.instances) {
      out.push({
        partId: id,
        defId: pl.def.id,
        isFin: !!pl.def.fin,
        isLeg: pl.def.kind === 'leg',
        height: pl.height,
        hScale: pl.height / pl.def.height,
        burnIndex: burnIndex.get(id) ?? 0,
        x: inst.x,
        y: inst.y,
        z: inst.z,
        angle: inst.angle,
        color: pl.def.color,
        engine: pl.def.kind === 'engine',
        exitRadius: pl.def.radiusBottom,
        pExit: plumeExitPressure(pl.def),
      });
    }
  }
  return out;
}

/** Staging sequence: separations in burn order with deploy states
 * interleaved (fairing after the first separation, nozzle extensions
 * when their stage becomes active), then terminal-descent deployables.
 * A released section's entry is a RELEASE — it spawns a vessel. */
function buildStagingEntries(compiled: Compiled): StagingEntry[] {
  const entries: StagingEntry[] = [];
  const vStages = compiled.vehicle.stages;
  const hasNozzle = (k: number): boolean => !!vStages[k]?.engines.some((g) => g.engine.nozzleExtension);
  const hasFairings = (compiled.geometry.fairings?.length ?? 0) > 0;
  if (hasNozzle(0)) entries.push({ kind: 'nozzle', afterStage: 0, label: 'Extend nozzle' });
  for (let i = 0; i + 1 < vStages.length; i++) {
    const rel = compiled.released?.find((r) => r.sectionBurnIndex === i);
    entries.push(
      rel
        ? { kind: 'release', afterStage: i, label: `Release ${rel.name}` }
        : { kind: 'sep', afterStage: i, label: `Separate stage ${i + 1}` },
    );
    if (i === 0 && hasFairings) {
      entries.push({ kind: 'deploy', effect: 'fairing', afterStage: -1, label: 'Jettison fairing' });
    }
    if (hasNozzle(i + 1)) {
      entries.push({ kind: 'nozzle', afterStage: i + 1, label: 'Extend nozzle' });
    }
  }
  if (vStages.length === 1 && hasFairings) {
    entries.push({ kind: 'deploy', effect: 'fairing', afterStage: -1, label: 'Jettison fairing' });
  }
  if (compiled.geometry.legs.length > 0) {
    entries.push({ kind: 'deploy', effect: 'legs', afterStage: -1, label: 'Deploy landing legs' });
  }
  if (compiled.geometry.chutes.length > 0) {
    entries.push({ kind: 'deploy', effect: 'chutes', afterStage: -1, label: 'Deploy parachute' });
  }
  return entries;
}

/** Nozzle exit-pressure proxy for plume visuals: vacuum bells sit near
 * their separation limit × 0.4 (the Summerfield relation inverted);
 * sea-level bells run mildly overexpanded at the pad (~0.6 atm). */
function plumeExitPressure(def: { engineId?: string; solidMotor?: string }): number {
  const id = def.engineId ?? def.solidMotor;
  if (!id) return P0_SEA_LEVEL * 0.6;
  const e = engineById(id);
  return isFinite(e.maxAmbientPressure) ? e.maxAmbientPressure * 0.4 : P0_SEA_LEVEL * 0.6;
}
