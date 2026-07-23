// Real-time 3-D view of the combat model (src/combat/dogfight.ts). The
// 2-D top-down engagement is embedded in 3-D — sim (x, y) maps to world
// (x, ALT, y), a horizontal arena a few km above a ground grid — and
// stepped at wall-clock time in fixed substeps, so what you watch is the
// exact deterministic sim a given seed produces (only the frame rate
// varies). Aircraft bank into their turns via the coordinated-turn
// relation tan φ = ωV/g; missiles fly their proportional-navigation
// paths and leave trails. Low-poly procedural meshes only — no assets.

import { Dogfight, Fighter, Missile } from '../combat/dogfight';
import { OrbitCamera } from '../gl/camera';
import { Mat4, multiply, rotationY, rotationZ, scaling, scalingXYZ, translation, v3, V3 } from '../gl/mat4';
import { MeshData, gridMesh } from '../gl/mesh';
import { Renderer } from '../gl/renderer';

/** Visual altitude of the fight above the ground grid [m]. */
const ARENA_ALT = 4_000;
/** Aircraft/missile meshes drawn oversize so they read against a km-scale
 * arena — a tactical-display convention, like map markers (the TRAILS
 * show the true paths). */
const JET_SCALE = 700;
const MSL_SCALE = 320;
const G = 9.80665;

const TEAM_COLOR: Record<'A' | 'B', [number, number, number]> = {
  A: [0.42, 0.62, 1.0],
  B: [1.0, 0.46, 0.4],
};

type Tri = [V3, V3, V3];

/** Flat-shaded mesh from a triangle list (sequential indices, per-face
 * normals — the low-poly look). */
function triMesh(tris: Tri[]): MeshData {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  const indices = new Uint16Array(tris.length * 3);
  tris.forEach((t, i) => {
    const [a, b, c] = t;
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m; ny /= m; nz /= m;
    [a, b, c].forEach((p, k) => {
      const o = i * 9 + k * 3;
      positions[o] = p.x; positions[o + 1] = p.y; positions[o + 2] = p.z;
      normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
    });
    indices[i * 3] = i * 3; indices[i * 3 + 1] = i * 3 + 1; indices[i * 3 + 2] = i * 3 + 2;
  });
  return { positions, normals, indices };
}

const p = (x: number, y: number, z: number): V3 => v3(x, y, z);
/** A double-sided triangle (visible from both faces). */
const dbl = (a: V3, b: V3, c: V3): Tri[] => [[a, b, c], [a, c, b]];

/** Little delta jet, nose along +Z. */
function jetMesh(): MeshData {
  const N = p(0, 0, 1.1), L = p(-0.8, 0, -0.5), R = p(0.8, 0, -0.5);
  const TL = p(-0.32, 0, -0.55), TR = p(0.32, 0, -0.55), TC = p(0, 0, -0.85);
  const F1 = p(0, 0, -0.5), F2 = p(0, 0.42, -0.78), F3 = p(0, 0, -0.85);
  return triMesh([
    ...dbl(N, L, R), // main delta
    ...dbl(TL, TR, TC), // tailplane
    ...dbl(F1, F2, F3), // vertical fin
  ]);
}

/** Slender missile dart, nose along +Z. */
function missileMesh(): MeshData {
  const nose = p(0, 0, 0.65), tail = p(0, 0, -0.6);
  const r = 0.09;
  const ring = [p(r, 0, 0.1), p(0, r, 0.1), p(-r, 0, 0.1), p(0, -r, 0.1)];
  const tris: Tri[] = [];
  for (let i = 0; i < 4; i++) {
    const a = ring[i]!, b = ring[(i + 1) % 4]!;
    tris.push([nose, a, b], [tail, b, a]);
  }
  return triMesh(tris);
}

interface Trail {
  pts: number[]; // flat x,y,z
  color: [number, number, number];
}

export class Dogfight3D {
  private df: Dogfight;
  private seed: number;
  private renderer: Renderer;
  private camera = new OrbitCamera();
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private lastFrame = 0;
  private running = true;
  private timeScale = 2;
  private seenEvents = 0;

  private banks = new Map<string, number>(); // fighter id → smoothed bank
  private headings = new Map<string, number>();
  private trails = new Map<string, Trail>();

  private hud!: HTMLElement;
  private feed!: HTMLElement;
  private banner!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private speedBtn!: HTMLButtonElement;

  constructor(private root: HTMLElement, private onExit: () => void, seed = 1) {
    this.seed = seed;
    this.df = new Dogfight({ seed });
    root.innerHTML = '';
    root.className = 'flight';
    this.canvas = document.createElement('canvas');
    root.appendChild(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.renderer.mesh('df-jet', jetMesh);
    this.renderer.mesh('df-missile', missileMesh);
    this.renderer.mesh('df-ground', () =>
      triMesh([
        ...dbl(p(-1, 0, -1), p(1, 0, -1), p(1, 0, 1)),
        ...dbl(p(-1, 0, -1), p(1, 0, 1), p(-1, 0, 1)),
      ]),
    );
    this.renderer.lineMesh('df-grid', gridMesh(24_000, 2_000));

    this.camera.minDist = 800;
    this.camera.maxDist = 160_000;
    this.camera.dist = 34_000;
    this.camera.pitch = 0.5;
    this.camera.yaw = 0.7;
    this.camera.target = v3(0, ARENA_ALT, 0);
    this.camera.attach(root, () => {});

    this.buildHud();
    (window as unknown as { __dogfight?: Dogfight3D }).__dogfight = this;
    new ResizeObserver(() => this.resize()).observe(root);
    this.resize();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  // ---------- world mapping ----------

  /** sim (x, y) → world (x, ALT, y). */
  private world(x: number, y: number): V3 {
    return v3(x, ARENA_ALT, y);
  }

  private centroid(): V3 {
    const live = this.df.fighters.filter((f) => f.alive);
    if (live.length === 0) return this.camera.target;
    let sx = 0, sy = 0;
    for (const f of live) { sx += f.pos.x; sy += f.pos.y; }
    return v3(sx / live.length, ARENA_ALT, sy / live.length);
  }

  // ---------- DOM ----------

  private buildHud(): void {
    this.hud = document.createElement('div');
    this.hud.className = 'hud';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<h3>Engagement</h3>';
    const grid = document.createElement('div');
    grid.className = 'readouts';
    grid.innerHTML =
      `<div class="label">Clock</div><div class="value" id="df-clock">T+0.0s</div>` +
      `<div class="label">Blue (A)</div><div class="value good" id="df-a">3</div>` +
      `<div class="label">Red (B)</div><div class="value bad" id="df-b">3</div>` +
      `<div class="label">Missiles up</div><div class="value" id="df-msl">0</div>`;
    panel.appendChild(grid);
    this.hud.appendChild(panel);
    this.feed = document.createElement('div');
    this.feed.className = 'panel event-feed';
    this.hud.appendChild(this.feed);
    this.root.appendChild(this.hud);

    this.banner = document.createElement('div');
    this.banner.className = 'banner';
    this.banner.style.display = 'none';
    this.root.appendChild(this.banner);

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
    this.playBtn = document.createElement('button');
    this.playBtn.textContent = '⏸ Pause';
    this.playBtn.onclick = () => {
      this.running = !this.running;
      this.playBtn.textContent = this.running ? '⏸ Pause' : '▶ Play';
    };
    this.speedBtn = document.createElement('button');
    this.speedBtn.textContent = '2×';
    this.speedBtn.onclick = () => {
      this.timeScale = this.timeScale >= 8 ? 1 : this.timeScale * 2;
      this.speedBtn.textContent = `${this.timeScale}×`;
    };
    const again = document.createElement('button');
    again.className = 'primary';
    again.textContent = 'New fight ▸';
    again.onclick = () => this.restart(this.seed + 1);
    cp.append(back, this.playBtn, this.speedBtn, again);
    bar.appendChild(cp);
    this.root.appendChild(bar);

    const hint = document.createElement('div');
    hint.className = 'vab-hint';
    hint.style.bottom = '62px';
    hint.textContent = 'drag: orbit · wheel: zoom · 3 Blue vs 3 Red air-launch fighters, 4 missiles each (proportional-navigation homing)';
    this.root.appendChild(hint);
  }

  private restart(seed: number): void {
    this.seed = seed;
    this.df = new Dogfight({ seed });
    this.banks.clear();
    this.headings.clear();
    this.trails.clear();
    this.seenEvents = 0;
    this.running = true;
    this.playBtn.textContent = '⏸ Pause';
    this.feed.innerHTML = '';
    this.banner.style.display = 'none';
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
    if (this.running && !this.df.done) this.df.advance(wallDt, this.timeScale);
    // Ease the camera toward the action centroid; the user still owns
    // yaw/pitch/zoom.
    const c = this.centroid();
    this.camera.target = v3(
      this.camera.target.x + (c.x - this.camera.target.x) * 0.05,
      ARENA_ALT,
      this.camera.target.z + (c.z - this.camera.target.z) * 0.05,
    );
    this.updateTrails();
    this.draw();
    this.pumpEvents();
    this.updateHud();
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateTrails(): void {
    for (const m of this.df.missiles) {
      if (!m.alive) continue;
      let tr = this.trails.get(m.id);
      if (!tr) { tr = { pts: [], color: TEAM_COLOR[m.team] }; this.trails.set(m.id, tr); }
      const w = this.world(m.pos.x, m.pos.y);
      tr.pts.push(w.x, w.y, w.z);
      if (tr.pts.length > 180) tr.pts.splice(0, 3);
    }
    for (const f of this.df.fighters) {
      if (!f.alive) continue;
      const key = `f${f.id}`;
      let tr = this.trails.get(key);
      if (!tr) { tr = { pts: [], color: TEAM_COLOR[f.team] }; this.trails.set(key, tr); }
      const w = this.world(f.pos.x, f.pos.y);
      tr.pts.push(w.x, w.y, w.z);
      if (tr.pts.length > 150) tr.pts.splice(0, 3);
    }
  }

  // ---------- render ----------

  private draw(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const near = Math.max(20, this.camera.dist * 0.02);
    const far = this.camera.dist * 12 + 200_000;
    this.renderer.begin(this.camera.proj(w / h, near, far), this.camera.viewRot(), this.camera.eye(), [0.36, 0.52, 0.72]);

    // Ground: a tinted plane under the arena + a grid for scale/motion.
    this.renderer.draw('df-ground', scalingXYZ(60_000, 1, 60_000), [0.16, 0.28, 0.2], 1);
    this.renderer.draw('df-grid', translation(0, 2, 0), [0.3, 0.42, 0.5], 0.5, true);

    // Trails.
    for (const [key, tr] of this.trails) {
      if (tr.pts.length < 6) continue;
      this.renderer.updateLines(`tr-${key}`, new Float32Array(tr.pts));
      const isMsl = !key.startsWith('f');
      this.renderer.draw(`tr-${key}`, translation(0, 0, 0), tr.color, isMsl ? 0.7 : 0.35, true);
    }

    const frameDt = 1 / 60;
    // Aircraft.
    for (const f of this.df.fighters) {
      if (!f.alive) continue;
      this.drawFighter(f, frameDt);
    }
    // Missiles.
    for (const m of this.df.missiles) {
      if (!m.alive) continue;
      this.drawMissile(m);
    }
  }

  private drawFighter(f: Fighter, frameDt: number): void {
    const heading = Math.atan2(f.vel.x, f.vel.y); // world: local +Z ↦ (sinψ,0,cosψ)
    const speed = Math.hypot(f.vel.x, f.vel.y);
    // Coordinated-turn bank: tan φ = ωV/g, ω from the heading change.
    const prev = this.headings.get(f.id);
    let omega = 0;
    if (prev !== undefined) {
      let d = heading - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      omega = d / frameDt;
    }
    this.headings.set(f.id, heading);
    const bankTarget = Math.atan2(-omega * speed, G);
    const bank = (this.banks.get(f.id) ?? 0) * 0.8 + Math.max(-1.1, Math.min(1.1, bankTarget)) * 0.2;
    this.banks.set(f.id, bank);

    const wpos = this.world(f.pos.x, f.pos.y);
    const model = multiply(
      multiply(translation(wpos.x, wpos.y, wpos.z), multiply(rotationY(heading), rotationZ(bank))),
      scaling(JET_SCALE),
    );
    this.renderer.draw('df-jet', model, TEAM_COLOR[f.team]);

    // Remaining ordnance under the wings — up to 4, two per side.
    const stations: [number, number][] = [[-0.42, -0.55], [-0.6, -0.4], [0.42, -0.55], [0.6, -0.4]];
    // Order so pairs deplete symmetrically (outer first).
    const order = [1, 3, 0, 2];
    for (let k = 0; k < f.missiles && k < 4; k++) {
      const st = stations[order[k]!]!;
      const local = multiply(translation(st[0] * JET_SCALE, -0.06 * JET_SCALE, st[1] * JET_SCALE), scaling(MSL_SCALE * 0.7));
      this.renderer.draw('df-missile', multiply(multiply(translation(wpos.x, wpos.y, wpos.z), rotationY(heading)), local), [0.85, 0.85, 0.88]);
    }
  }

  private drawMissile(m: Missile): void {
    const heading = Math.atan2(m.vel.x, m.vel.y);
    const wpos = this.world(m.pos.x, m.pos.y);
    const model = multiply(multiply(translation(wpos.x, wpos.y, wpos.z), rotationY(heading)), scaling(MSL_SCALE));
    this.renderer.draw('df-missile', model, [0.95, 0.9, 0.7]);
    // A hot exhaust dot while boosting.
    const boost = performance.now(); // flicker is render-only
    if ((boost % 60) < 45) {
      const back = multiply(multiply(translation(wpos.x, wpos.y, wpos.z), rotationY(heading)), multiply(translation(0, 0, -0.7 * MSL_SCALE), scaling(MSL_SCALE * 0.35)));
      this.renderer.draw('df-missile', back, [1.0, 0.7, 0.3], 0.8, true);
    }
  }

  private pumpEvents(): void {
    const evs = this.df.events;
    for (; this.seenEvents < evs.length; this.seenEvents++) {
      const e = evs[this.seenEvents]!;
      let text = '';
      if (e.type === 'fire') text = `${e.by} → ${e.at} (${(e.range / 1000).toFixed(1)} km)`;
      else if (e.type === 'kill') text = `💥 ${e.target} down (${e.by})`;
      else if (e.type === 'evade') text = `${e.by} breaks — inbound`;
      else if (e.type === 'end') {
        this.banner.textContent =
          e.winner === 'draw' ? 'Mutual kill — no victor' : `Team ${e.winner === 'A' ? 'Blue' : 'Red'} wins  ${e.survivorsA}–${e.survivorsB}`;
        this.banner.className = `banner ${e.winner === 'draw' ? 'crash' : 'orbit'}`;
        this.banner.style.display = 'block';
      }
      if (!text) continue;
      const div = document.createElement('div');
      div.textContent = `T+${e.t.toFixed(1)}s  ${text}`;
      this.feed.prepend(div);
      while (this.feed.children.length > 6) this.feed.lastChild?.remove();
    }
  }

  private updateHud(): void {
    const set = (id: string, v: string): void => {
      const el = this.hud.querySelector<HTMLElement>(`#${id}`);
      if (el) el.textContent = v;
    };
    set('df-clock', `T+${this.df.t.toFixed(1)}s`);
    set('df-a', String(this.df.living('A').length));
    set('df-b', String(this.df.living('B').length));
    set('df-msl', String(this.df.missiles.filter((m) => m.alive).length));
  }
}
