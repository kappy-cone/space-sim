// A standalone 3-D world viewer — the world the flights accumulate,
// explorable on its own without launching anything. It reads the world
// (registry, sites, ground network, the Moon) and renders it as a globe
// you can orbit and zoom; time can be animated (read-only — it never
// writes the world, so viewing is completely independent of flying).
//
// The sim's orbital plane is embedded as the world XZ plane, Earth at the
// origin; objects, orbits, and the Moon are propagated analytically at
// the view time (the same on-demand Kepler the world uses).

import { OrbitCamera } from '../gl/camera';
import { multiply, rotationY, scaling, translation, v3, V3 } from '../gl/mat4';
import { moonColor, segmentsMesh, sphereMesh, terrainColor } from '../gl/mesh';
import { Renderer } from '../gl/renderer';
import { EARTH, bodyById, bodyOrbitState } from '../physics/bodies';
import { SITES } from '../physics/sites';
import { Vec2 } from '../physics/vec2';
import { GROUND_STATIONS, stationPos } from '../world/network';
import { ObjectKind, WorldState, objectElements, objectStateAt, siteState } from '../world/world';
import { fmtDistance, fmtTime } from './format';
import { buildStarfield } from './flight3d';

const KIND_COLOR: Record<string, [number, number, number]> = {
  debris: [0.55, 0.55, 0.58],
  relay: [0.45, 0.75, 0.95],
  survey: [0.5, 0.9, 0.6],
  tug: [0.95, 0.7, 0.4],
  vessel: [0.9, 0.9, 0.92],
};
const objColor = (kind: ObjectKind, func?: string): [number, number, number] => KIND_COLOR[func ?? kind] ?? KIND_COLOR.vessel!;

export class WorldViewer {
  private renderer: Renderer;
  private camera = new OrbitCamera();
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private lastFrame = 0;
  private time: number;
  private playing = false;
  private timeScale = 3600; // 1 h/s default so orbits visibly move
  private hud!: HTMLElement;

  constructor(private root: HTMLElement, private onExit: () => void, private world: WorldState) {
    this.time = world.epoch;
    root.innerHTML = '';
    root.className = 'flight';
    this.canvas = document.createElement('canvas');
    root.appendChild(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.renderer.mesh('wv-earth', () => sphereMesh(64, 96, terrainColor));
    this.renderer.mesh('wv-moon', () => sphereMesh(32, 48, moonColor));
    this.renderer.mesh('wv-shell', () => sphereMesh(24, 36));
    // A little octahedral marker for sites and registry objects.
    this.renderer.mesh('wv-marker', () =>
      segmentsMesh([
        { y0: -1, y1: 0, r0: 0, r1: 1 },
        { y0: 0, y1: 1, r0: 1, r1: 0 },
      ]),
    );
    this.renderer.lineMesh('wv-stars', buildStarfield(700));

    this.camera.minDist = EARTH.radius * 1.05;
    this.camera.maxDist = 6e8;
    this.camera.dist = EARTH.radius * 3.2;
    this.camera.pitch = 0.55;
    this.camera.yaw = 0.7;
    this.camera.target = v3(0, 0, 0);
    this.camera.attach(root, () => {});

    this.buildHud();
    (window as unknown as { __world?: WorldViewer }).__world = this;
    new ResizeObserver(() => this.resize()).observe(root);
    this.resize();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  /** sim-plane point (body-relative) → world XZ, offset to the body. */
  private worldPos(r: Vec2, body = 'earth'): V3 {
    if (body === 'earth') return v3(r.x, 0, r.y);
    const eph = bodyOrbitState(bodyById(body), this.time).r;
    return v3(r.x + eph.x, 0, r.y + eph.y);
  }

  // ---------- DOM ----------

  private buildHud(): void {
    this.hud = document.createElement('div');
    this.hud.className = 'hud';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<h3>World</h3>';
    const grid = document.createElement('div');
    grid.className = 'readouts';
    grid.id = 'wv-grid';
    panel.appendChild(grid);
    this.hud.appendChild(panel);
    const legend = document.createElement('div');
    legend.className = 'panel';
    legend.style.fontSize = '11px';
    legend.innerHTML =
      '<h3>Legend</h3>' +
      Object.entries({ relay: 'Relay', survey: 'Survey', tug: 'Tug', vessel: 'Vessel', debris: 'Debris' })
        .map(([k, label]) => {
          const c = KIND_COLOR[k]!.map((v) => Math.round(v * 255)).join(',');
          return `<div><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:rgb(${c});margin-right:6px"></span>${label}</div>`;
        })
        .join('');
    this.hud.appendChild(legend);
    this.root.appendChild(this.hud);

    const bar = document.createElement('div');
    bar.className = 'controls';
    const cp = document.createElement('div');
    cp.className = 'panel';
    cp.style.display = 'flex';
    cp.style.gap = '8px';
    cp.style.alignItems = 'center';
    const back = document.createElement('button');
    back.textContent = '◂ VAB';
    back.onclick = () => this.onExit();
    const play = document.createElement('button');
    play.className = 'primary';
    play.textContent = '▶ Play';
    play.onclick = () => {
      this.playing = !this.playing;
      play.textContent = this.playing ? '⏸ Pause' : '▶ Play';
    };
    const speed = document.createElement('button');
    const speeds = [600, 3600, 21600, 86400]; // 10 min/s … 1 day/s
    speed.textContent = '1 h/s';
    speed.onclick = () => {
      const i = (speeds.indexOf(this.timeScale) + 1) % speeds.length;
      this.timeScale = speeds[i]!;
      speed.textContent = this.timeScale >= 86400 ? '1 d/s' : this.timeScale >= 21600 ? '6 h/s' : this.timeScale >= 3600 ? '1 h/s' : '10 min/s';
    };
    const reset = document.createElement('button');
    reset.textContent = '⟲ Now';
    reset.onclick = () => (this.time = this.world.epoch);
    cp.append(back, play, speed, reset);
    bar.appendChild(cp);
    this.root.appendChild(bar);

    const hint = document.createElement('div');
    hint.className = 'vab-hint';
    hint.style.bottom = '62px';
    hint.textContent = 'The world your flights build — drag: orbit · wheel: zoom · Play animates time (read-only; nothing is written)';
    this.root.appendChild(hint);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.root.clientWidth * dpr;
    this.canvas.height = this.root.clientHeight * dpr;
    this.canvas.style.width = `${this.root.clientWidth}px`;
    this.canvas.style.height = `${this.root.clientHeight}px`;
  }

  // ---------- loop ----------

  private frame = (now: number): void => {
    const wallDt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.playing) this.time += wallDt * this.timeScale;
    this.draw();
    this.updateHud();
    this.raf = requestAnimationFrame(this.frame);
  };

  private markerScale(): number {
    return Math.max(EARTH.radius * 0.008, this.camera.dist * 0.012);
  }

  private draw(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const near = Math.max(1_000, this.camera.dist * 0.02);
    const far = this.camera.dist * 4 + 9e8;
    this.renderer.begin(this.camera.proj(w / h, near, far), this.camera.viewRot(), this.camera.eye(), [0.01, 0.012, 0.03]);

    // Stars fixed to the eye (at infinity).
    const eye = this.camera.eye();
    this.renderer.draw('wv-stars', multiply(translation(eye.x, eye.y, eye.z), scaling(far * 0.9)), [0.9, 0.92, 1.0], 0.8, true);

    // Earth (spun) + atmosphere haze.
    this.renderer.draw('wv-earth', multiply(rotationY(-EARTH.rotationRate * this.time), scaling(EARTH.radius)), [1, 1, 1], 1, false, false, true);
    this.renderer.draw('wv-shell', scaling(EARTH.radius + 60_000), [0.4, 0.6, 0.95], 0.06);

    // The Moon on its orbit.
    const moon = bodyById('moon');
    const meph = bodyOrbitState(moon, this.time).r;
    const mw = this.worldPos(meph);
    this.renderer.draw('wv-moon', multiply(translation(mw.x, mw.y, mw.z), scaling(moon.radius)), [1, 1, 1]);
    // Moon orbit ring.
    this.ring('wv-moon-orbit', Math.hypot(meph.x, meph.y), 0, 0, 0, v3(0, 0, 0), [0.4, 0.42, 0.5], 0.4);

    const ms = this.markerScale();

    // Sites: discovered solid, undiscovered dim — pads amber, runways
    // cyan, ground stations white.
    for (const s of SITES) {
      if (s.body !== 'earth') continue;
      const a = s.angle + EARTH.rotationRate * this.time;
      const world = this.worldPos({ x: EARTH.radius * Math.cos(a), y: EARTH.radius * Math.sin(a) });
      const disc = siteState(this.world, s.id).discovered;
      const col: [number, number, number] = s.type === 'pad' ? [1, 0.78, 0.34] : [0.4, 0.8, 1];
      this.renderer.draw('wv-marker', multiply(translation(world.x, world.y, world.z), scaling(ms)), col, disc ? 1 : 0.25, true);
    }
    for (const st of GROUND_STATIONS) {
      const pos = stationPos(st, this.time);
      const world = this.worldPos(pos);
      this.renderer.draw('wv-marker', multiply(translation(world.x, world.y, world.z), scaling(ms * 1.2)), [1, 1, 1], 1, true);
    }

    // Registry objects: orbit rings for satellites, a marker for each.
    for (const o of this.world.objects) {
      const el = objectElements(o);
      const bodyOff = o.body === 'earth' ? v3(0, 0, 0) : this.worldPos({ x: 0, y: 0 }, o.body);
      if (o.kind === 'satellite' && el.e < 1) {
        this.ring(`wv-o-${o.id}`, el.rApo, el.rPeri, el.argPeri, el.h >= 0 ? 1 : -1, bodyOff, objColor(o.kind, o.func), 0.5);
      }
      const s = objectStateAt(o, this.time);
      const world = this.worldPos(s.r, o.body);
      this.renderer.draw('wv-marker', multiply(translation(world.x, world.y, world.z), scaling(ms * (o.kind === 'debris' ? 0.6 : 0.9))), objColor(o.kind, o.func), 0.95, true);
    }
  }

  /** Draw an orbit ellipse ring in the XZ plane. rApo/rPeri define the
   * conic; argPeri + direction orient it; offset places the focus. */
  private ring(key: string, rApo: number, rPeri: number, argPeri: number, dir: number, off: V3, color: [number, number, number], alpha: number): void {
    const a = (rApo + rPeri) / 2;
    const e = a > 0 ? (rApo - rPeri) / (rApo + rPeri) : 0;
    const p = a * (1 - e * e);
    const pts = new Float32Array(129 * 3);
    for (let i = 0; i <= 128; i++) {
      const nu = (i / 128) * 2 * Math.PI;
      const rad = e < 1e-9 ? a : p / (1 + e * Math.cos(nu));
      const ang = argPeri + dir * nu;
      pts[i * 3] = off.x + rad * Math.cos(ang);
      pts[i * 3 + 1] = off.y;
      pts[i * 3 + 2] = off.z + rad * Math.sin(ang);
    }
    this.renderer.updateLines(key, pts);
    this.renderer.draw(key, translation(0, 0, 0), color, alpha, true);
  }

  private updateHud(): void {
    const objs = this.world.objects;
    const count = (pred: (o: (typeof objs)[number]) => boolean): number => objs.filter(pred).length;
    const grid = this.hud.querySelector('#wv-grid');
    if (grid) {
      grid.innerHTML =
        `<div class="label">View time</div><div class="value">T ${fmtTime(this.time)}</div>` +
        `<div class="label">Launches</div><div class="value">${this.world.launches}</div>` +
        `<div class="label">On orbit</div><div class="value">${objs.length}</div>` +
        `<div class="label">Satellites</div><div class="value">${count((o) => o.kind === 'satellite')}</div>` +
        `<div class="label">Debris</div><div class="value">${count((o) => o.kind === 'debris')}</div>` +
        `<div class="label">Altitude</div><div class="value">${fmtDistance(this.camera.dist - EARTH.radius)}</div>`;
    }
  }
}
