// A top-down 2-D air-combat model — deliberately SEPARATE from the
// orbital Sim, whose single plane is the vertical orbital plane (no
// azimuth to turn in, so a real turning dogfight cannot live there).
// This is the standard 3-DOF point-mass air-combat formulation: aircraft
// hold speed and turn at a load-factor-limited rate, and fire
// proportional-navigation missiles. References: R. Shaw, "Fighter
// Combat: Tactics and Maneuvering" (energy-maneuverability, the beam/
// break evasion); Zarchan, "Tactical and Strategic Missile Guidance"
// (PN, ch. 2). Every number is sourced or flagged as an estimate; the
// missile's mass/thrust/burn come straight from the mk36 roster entry
// (physics/parts.ts), so the builder part and the dogfight agree.
//
// Determinism: no Date.now / Math.random — a mulberry32 PRNG seeded from
// the caller sets the only asymmetry (lateral spawn offsets), so a given
// seed always plays out identically (pinned by test).

import { Vec2, add, dot, norm, perp, scale, sub, vec } from '../physics/vec2';
import { G0 } from '../physics/constants';
import { leadIntercept, steerByProNav } from './guidance';

// ---- aircraft (Air-Launcher-carrier class, treated as a fighter) ----
/** Combat cruise speed [m/s] ≈ M0.85 at 8 km (the carrier's jet band). */
const FIGHTER_SPEED = 260;
/** Structural load-factor limit [g] — combat aircraft class (ESTIMATE;
 * transports pull less, fighters 7–9; 6 is a conservative middle). */
const FIGHTER_MAX_G = 6;
/** Seeker/launch envelope: max range [m] and half-cone off boresight. */
const LAUNCH_RANGE = 9_000; // WVR class
const SEEKER_HALF_CONE = (45 * Math.PI) / 180;
const RELOAD_TIME = 3; // s between salvo shots off the rails — ESTIMATE
/** Evade when an incoming missile is within this range and closing. */
const THREAT_RANGE = 4_500;

// ---- missile (mk36 roster numbers) ----
const MSL_LAUNCH_MASS = 85; // seeker 30 + case 12 + grain 35 + fins ~8 [kg]
const MSL_GRAIN = 35;
const MSL_THRUST = 16_100; // N — mk36 rated
const MSL_ISP = 235; // s
const MSL_BURN = (MSL_GRAIN * MSL_ISP * G0) / MSL_THRUST; // ≈ 5.0 s (impulse/thrust)
const MSL_MDOT = MSL_GRAIN / MSL_BURN;
/** Airframe max lateral acceleration [g] — tactical missile class. */
const MSL_MAX_G = 30;
/** Frontal reference area [m²] for drag (0.127 m airframe). */
const MSL_AREA = Math.PI * 0.0635 * 0.0635;
const MSL_CD = 0.35; // supersonic body drag class (Hoerner) — ESTIMATE
/** Combat-altitude air density [kg/m³] — USSA76 at ~8 km (atmosphere.ts
 * band); held constant (the whole fight is in one altitude block). */
const RHO_COMBAT = 0.526;
/** Blast/proximity-fuze lethal radius [m] — WDU-17 class scalar
 * (published lethal radius ~5–11 m); the ONE invented combat scalar. */
const LETHAL_RADIUS = 12;
/** Below this speed [m/s] a spent missile can no longer maneuver to a
 * kill — it is scored a miss (energy depleted). */
const MSL_MIN_SPEED = 380;
const MSL_MAX_FLIGHT = 40; // s hard self-destruct

const turnRate = (gLimit: number, speed: number): number => (G0 * Math.sqrt(gLimit * gLimit - 1)) / speed;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Team = 'A' | 'B';

export interface Fighter {
  id: string;
  team: Team;
  name: string;
  pos: Vec2;
  vel: Vec2;
  alive: boolean;
  missiles: number;
  cooldown: number;
  /** Altitude [m] — 0 on the runway, ramps to COMBAT_ALT on climb-out.
   * The combat itself is co-altitude (all fighting happens at
   * COMBAT_ALT); altitude only drives the takeoff sequence + rendering. */
  alt: number;
  /** Flight phase: ground roll → climb-out → engaged. */
  phase: 'roll' | 'climb' | 'combat';
  /** This pilot's launch range [m] — seeded within the envelope so a
   * flight doesn't volley in perfect unison (trigger discipline varies). */
  launchRange: number;
  /** Missile id currently being defended against (one evade log per break). */
  evadingFrom?: string;
}

export interface Missile {
  id: string;
  team: Team;
  /** Name of the fighter that fired it (for readable events). */
  shooter: string;
  pos: Vec2;
  vel: Vec2;
  mass: number;
  t0: number;
  target: string;
  alive: boolean;
}

export type CombatEvent =
  | { t: number; type: 'fire'; by: string; at: string; range: number }
  | { t: number; type: 'evade'; by: string; from: string }
  | { t: number; type: 'kill'; missile: string; target: string; by: string }
  | { t: number; type: 'miss'; missile: string; target: string; reason: string }
  | { t: number; type: 'end'; winner: Team | 'draw'; survivorsA: number; survivorsB: number };

export interface DogfightResult {
  events: CombatEvent[];
  winner: Team | 'draw';
  survivors: { A: Fighter[]; B: Fighter[] };
  duration: number;
  shots: number;
  hits: number;
}

const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');

export interface DogfightOptions {
  seed?: number;
  missilesPerFighter?: number;
  /** Names per team (defaults Alpha/Bravo flights). */
  names?: { A: string[]; B: string[] };
  dt?: number;
  maxTime?: number;
  /** Downrange distance of each team's runway from the arena centre [m] —
   * the view passes its far-side runway offset so the fighters take off
   * from exactly where the strips are drawn. */
  baseX?: number;
}

/** Co-altitude of the engagement [m] — takeoff climbs to it, the fight
 * happens at it (shared by the model and the 3-D view). */
export const COMBAT_ALT = 4_000;
const ROLL_START = 30; // m/s brakes-off speed
const ROLL_ACCEL = 12; // m/s² ground-roll acceleration (fighter class — ESTIMATE)
const ROTATE_SPEED = 80; // m/s rotation speed Vr (ESTIMATE)
const CLIMB_RATE = 250; // m/s vertical — F-16-class initial climb rate (ESTIMATE)

/**
 * A steppable 3-v-3 (or N-v-N) engagement. Team A spawns west heading
 * east, Team B east heading west, with seeded lateral offsets. The
 * physics step is a fixed dt so a given seed always plays out
 * identically; the real-time 3-D view (ui/dogfight3d.ts) drives it in
 * fixed substeps, the headless `simulateDogfight` runs it to the end —
 * both get the same outcome.
 */
export class Dogfight {
  readonly fighters: Fighter[] = [];
  readonly missiles: Missile[] = [];
  readonly events: CombatEvent[] = [];
  t = 0;
  done = false;
  winner: Team | 'draw' = 'draw';
  shots = 0;
  hits = 0;
  readonly loadout: number;
  private readonly dt: number;
  private readonly maxTime: number;
  private mid = 0;
  private lastAction = 0;

  constructor(opts: DogfightOptions = {}) {
    const rnd = mulberry32(opts.seed ?? 1);
    this.dt = opts.dt ?? 0.05;
    this.maxTime = opts.maxTime ?? 180;
    // Four missiles per fighter — two per wing bay (a full rail loadout).
    this.loadout = opts.missilesPerFighter ?? 4;
    const nA = opts.names?.A ?? ['Alpha 1', 'Alpha 2', 'Alpha 3'];
    const nB = opts.names?.B ?? ['Bravo 1', 'Bravo 2', 'Bravo 3'];
    const n = Math.min(nA.length, nB.length);
    const spread = 1_400; // m of lateral separation between wingmen on the strip
    const baseX = opts.baseX ?? 11_000; // ≈ the Meridian runway offset
    // The teams START ON THEIR RUNWAYS at ±baseX and take off toward the
    // centre — a ground roll, rotation, and climb before the merge. Lateral
    // offsets are drawn INDEPENDENTLY per side (not mirrored) so the
    // geometry — and the outcome — is genuinely asymmetric.
    const lr = (): number => LAUNCH_RANGE * (0.45 + 0.5 * rnd());
    for (let i = 0; i < n; i++) {
      const base = (i - (n - 1) / 2) * spread;
      this.fighters.push({
        id: `A${i}`, team: 'A', name: nA[i]!,
        pos: vec(-baseX, base + (rnd() - 0.5) * 800),
        vel: vec(ROLL_START, 0), alive: true, missiles: this.loadout, cooldown: 0,
        alt: 0, phase: 'roll', launchRange: lr(),
      });
      this.fighters.push({
        id: `B${i}`, team: 'B', name: nB[i]!,
        pos: vec(baseX, base + (rnd() - 0.5) * 800),
        vel: vec(-ROLL_START, 0), alive: true, missiles: this.loadout, cooldown: 0,
        alt: 0, phase: 'roll', launchRange: lr(),
      });
    }
  }

  /** Fighters still airborne AND engaged (co-altitude) — valid weapon
   * targets. A plane on its takeoff roll or climb-out is not yet a shooter
   * or a target. */
  private combatants(team: Team): Fighter[] {
    return this.fighters.filter((f) => f.alive && f.team === team && f.phase === 'combat');
  }

  /** Ground roll → rotate → climb to the co-altitude, then hand off to the
   * combat AI. Heading is held down the runway (toward the centre). */
  private takeoff(f: Fighter, dt: number): void {
    const dir = norm(f.vel) > 1e-6 ? scale(f.vel, 1 / norm(f.vel)) : vec(Math.sign(f.pos.x) < 0 ? 1 : -1, 0);
    let speed = norm(f.vel);
    if (f.phase === 'roll') {
      speed = Math.min(FIGHTER_SPEED, speed + ROLL_ACCEL * dt);
      if (speed >= ROTATE_SPEED) f.phase = 'climb';
    } else {
      speed = Math.min(FIGHTER_SPEED, speed + ROLL_ACCEL * 0.5 * dt);
      f.alt = Math.min(COMBAT_ALT, f.alt + CLIMB_RATE * dt);
      if (f.alt >= COMBAT_ALT && speed >= FIGHTER_SPEED * 0.9) {
        f.phase = 'combat';
        f.alt = COMBAT_ALT;
      }
    }
    f.vel = scale(dir, speed);
    f.pos = add(f.pos, scale(f.vel, dt));
  }

  living(team: Team): Fighter[] {
    return this.fighters.filter((f) => f.alive && f.team === team);
  }
  private byId(id: string): Fighter | undefined {
    return this.fighters.find((f) => f.id === id);
  }

  /** Advance one fixed physics step (no-op once the engagement ends). */
  step(): void {
    if (this.done) return;
    const { dt, missiles, events } = this;
    const t = this.t;
    if (
      t > this.maxTime ||
      this.living('A').length === 0 ||
      this.living('B').length === 0 ||
      // Ordnance expended and none in flight — no gun, so it's decided.
      (this.fighters.every((f) => !f.alive || f.missiles === 0) && missiles.every((m) => !m.alive)) ||
      // Stalemate: once combat is JOINED (a shot has been fired), if
      // equal-energy survivors then circle without a firing solution and
      // nothing is in the air for a while, call it. Never fires during
      // the takeoff/approach, when no shot has happened yet.
      (this.shots > 0 && t - this.lastAction > 35 && missiles.every((m) => !m.alive))
    ) {
      this.finish();
      return;
    }

    // ---- aircraft: take off, then pick target / evade / pursue + fire ----
    for (const f of this.fighters) {
      if (!f.alive) continue;
      f.cooldown = Math.max(0, f.cooldown - dt);
      // Still getting airborne: roll/rotate/climb, no weapons.
      if (f.phase !== 'combat') {
        this.takeoff(f, dt);
        continue;
      }
      // Pursue any living enemy (even one still climbing), but only fire
      // at co-altitude combatants.
      const foes = this.living(other(f.team));
      if (foes.length === 0) continue;
      const targets = this.combatants(other(f.team));

      let threat: Missile | null = null;
      let threatRange = THREAT_RANGE;
      for (const m of missiles) {
        if (!m.alive || m.team === f.team || m.target !== f.id) continue;
        const rel = sub(f.pos, m.pos); // missile → fighter
        const rng = norm(rel);
        if (rng < threatRange && dot(rel, sub(f.vel, m.vel)) < 0) {
          threat = m;
          threatRange = rng;
        }
      }

      const speed = norm(f.vel);
      const wRate = turnRate(FIGHTER_MAX_G, speed);
      let desired: Vec2;
      if (threat) {
        const los = sub(f.pos, threat.pos);
        const b1 = perp(los);
        const b2 = scale(b1, -1);
        desired = dot(b1, f.vel) >= dot(b2, f.vel) ? b1 : b2;
        if (f.evadingFrom !== threat.id) {
          f.evadingFrom = threat.id;
          events.push({ t, type: 'evade', by: f.name, from: threat.shooter });
        }
      } else {
        f.evadingFrom = undefined;
        const tgt = nearest(f, foes);
        desired = sub(leadIntercept(f.pos, speed, tgt.pos, tgt.vel), f.pos);
      }
      f.vel = turnToward(f.vel, desired, wRate * dt);
      f.pos = add(f.pos, scale(f.vel, dt));

      if (!threat && f.missiles > 0 && f.cooldown <= 0 && targets.length > 0) {
        const tgt = nearest(f, targets);
        const los = sub(tgt.pos, f.pos);
        const rng = norm(los);
        const off = Math.acos(Math.max(-1, Math.min(1, dot(los, f.vel) / (rng * norm(f.vel) || 1))));
        if (rng <= f.launchRange && off <= SEEKER_HALF_CONE) {
          missiles.push({
            id: `m${this.mid++}`, team: f.team, shooter: f.name,
            pos: { ...f.pos }, vel: { ...f.vel }, mass: MSL_LAUNCH_MASS,
            t0: t, target: tgt.id, alive: true,
          });
          f.missiles -= 1;
          f.cooldown = RELOAD_TIME;
          this.shots += 1;
          events.push({ t, type: 'fire', by: f.name, at: tgt.name, range: rng });
          this.lastAction = t;
        }
      }
    }

    // ---- missiles: PN homing, rocket boost + drag, lethality ----
    for (const m of missiles) {
      if (!m.alive) continue;
      const tgt = this.byId(m.target);
      if (!tgt || !tgt.alive) {
        m.alive = false;
        events.push({ t, type: 'miss', missile: m.id, target: this.byId(m.target)?.name ?? m.target, reason: 'target already down' });
        continue;
      }
      let speed = norm(m.vel);
      const burning = t - m.t0 < MSL_BURN;
      if (burning) m.mass = Math.max(MSL_LAUNCH_MASS - MSL_GRAIN, m.mass - MSL_MDOT * dt);
      const thrust = burning ? MSL_THRUST : 0;
      const drag = 0.5 * RHO_COMBAT * speed * speed * MSL_CD * MSL_AREA;
      speed = Math.max(0, speed + ((thrust - drag) / m.mass) * dt);
      const maxTurn = (MSL_MAX_G * G0) / Math.max(speed, 1);
      const dir = norm(m.vel) > 1e-6 ? scale(m.vel, 1 / norm(m.vel)) : vec(1, 0);
      const steered = steerByProNav(m.pos, scale(dir, speed), tgt.pos, tgt.vel, dt, maxTurn);
      m.vel = norm(steered) > 1e-6 ? scale(steered, speed / norm(steered)) : scale(dir, speed);
      m.pos = add(m.pos, scale(m.vel, dt));

      const miss = segmentMiss(m.pos, sub(m.pos, scale(m.vel, dt)), tgt.pos, sub(tgt.pos, scale(tgt.vel, dt)));
      if (miss <= LETHAL_RADIUS) {
        m.alive = false;
        tgt.alive = false;
        this.hits += 1;
        events.push({ t, type: 'kill', missile: m.id, target: tgt.name, by: m.shooter });
        this.lastAction = t;
        continue;
      }
      if (t - m.t0 > MSL_MAX_FLIGHT) {
        m.alive = false;
        events.push({ t, type: 'miss', missile: m.id, target: tgt.name, reason: 'flight time expired' });
      } else if (!burning && speed < MSL_MIN_SPEED) {
        m.alive = false;
        events.push({ t, type: 'miss', missile: m.id, target: tgt.name, reason: 'energy depleted' });
      }
    }
    this.t += dt;
  }

  /** Advance by real wall-clock seconds at a time scale, in fixed
   * substeps — deterministic regardless of frame rate. */
  advance(realSeconds: number, timeScale = 1): void {
    let acc = realSeconds * timeScale;
    let guard = 0;
    while (acc >= this.dt && !this.done && guard++ < 20_000) {
      this.step();
      acc -= this.dt;
    }
  }

  private finish(): void {
    if (this.done) return;
    const a = this.living('A').length;
    const b = this.living('B').length;
    this.winner = a > b ? 'A' : b > a ? 'B' : 'draw';
    this.events.push({ t: this.t, type: 'end', winner: this.winner, survivorsA: a, survivorsB: b });
    this.done = true;
  }

  result(): DogfightResult {
    return {
      events: this.events,
      winner: this.winner,
      survivors: { A: this.living('A'), B: this.living('B') },
      duration: this.t,
      shots: this.shots,
      hits: this.hits,
    };
  }
}

/** Run an engagement to completion (headless — tests, reports). */
export function simulateDogfight(opts: DogfightOptions = {}): DogfightResult {
  const df = new Dogfight(opts);
  while (!df.done) df.step();
  return df.result();
}

function nearest(f: Fighter, foes: Fighter[]): Fighter {
  let best = foes[0]!;
  let bestD = Infinity;
  for (const g of foes) {
    const d = norm(sub(g.pos, f.pos));
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

/** Rotate velocity toward `desired` by at most `maxStep` radians. */
function turnToward(vel: Vec2, desired: Vec2, maxStep: number): Vec2 {
  const speed = norm(vel);
  if (speed < 1e-6 || norm(desired) < 1e-6) return vel;
  const cur = Math.atan2(vel.y, vel.x);
  const want = Math.atan2(desired.y, desired.x);
  let d = want - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const step = Math.max(-maxStep, Math.min(maxStep, d));
  const ns = cur + step;
  return vec(Math.cos(ns) * speed, Math.sin(ns) * speed);
}

/** Closest distance between two moving points over a step, given their
 * end (p1,q1) and start (p0,q0) positions — the segment/segment minimum
 * for the missile-vs-target terminal miss distance. */
function segmentMiss(p1: Vec2, p0: Vec2, q1: Vec2, q0: Vec2): number {
  // Relative motion: closest approach of the relative segment to origin.
  const r0 = sub(p0, q0);
  const r1 = sub(p1, q1);
  const d = sub(r1, r0);
  const dd = dot(d, d);
  let s = dd > 1e-9 ? -dot(r0, d) / dd : 0;
  s = Math.max(0, Math.min(1, s));
  return norm(add(r0, scale(d, s)));
}

/** Human-readable play-by-play for the report. */
export function narrateDogfight(r: DogfightResult): string[] {
  const lines: string[] = [];
  const fmt = (t: number): string => `T+${t.toFixed(1)}s`;
  for (const e of r.events) {
    switch (e.type) {
      case 'fire':
        lines.push(`${fmt(e.t)}  ${e.by} fires on ${e.at} (${(e.range / 1000).toFixed(1)} km)`);
        break;
      case 'evade':
        lines.push(`${fmt(e.t)}  ${e.by} breaks hard — incoming missile`);
        break;
      case 'kill':
        lines.push(`${fmt(e.t)}  💥 ${e.target} destroyed`);
        break;
      case 'miss':
        lines.push(
          e.reason === 'target already down'
            ? `${fmt(e.t)}  a missile goes ballistic — ${e.target} was already down`
            : `${fmt(e.t)}  ${e.target} defeats the missile (${e.reason})`,
        );
        break;
      case 'end':
        lines.push(
          `${fmt(e.t)}  ENGAGEMENT OVER — ${
            e.winner === 'draw' ? 'mutual attrition, no victor' : `Team ${e.winner} wins`
          } (A:${e.survivorsA} B:${e.survivorsB})`,
        );
        break;
    }
  }
  return lines;
}
