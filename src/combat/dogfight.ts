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
const RELOAD_TIME = 8; // s between shots off a rail — ESTIMATE
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
}

/**
 * Run a 3-v-3 (or N-v-N) engagement to elimination or the time limit.
 * Team A spawns west heading east, Team B east heading west, with
 * seeded lateral offsets. Returns the full event timeline and outcome.
 */
export function simulateDogfight(opts: DogfightOptions = {}): DogfightResult {
  const rnd = mulberry32(opts.seed ?? 1);
  const dt = opts.dt ?? 0.05;
  const maxTime = opts.maxTime ?? 120;
  // One missile per fighter: the Air Launcher carries a single release
  // pylon, so a flight's ordnance IS its aircraft count. A single
  // merge-and-volley engagement is the honest result of that loadout.
  const perF = opts.missilesPerFighter ?? 1;
  const nA = opts.names?.A ?? ['Alpha 1', 'Alpha 2', 'Alpha 3'];
  const nB = opts.names?.B ?? ['Bravo 1', 'Bravo 2', 'Bravo 3'];
  const n = Math.min(nA.length, nB.length);

  const fighters: Fighter[] = [];
  const spread = 4_000; // m of lateral separation between wingmen
  // Start near the merge (~18 km apart) so the engagement is a turning
  // fight, not a 60 km cruise-in. Lateral offsets are drawn INDEPENDENTLY
  // per side (not mirrored) so the geometry — and thus the outcome — is
  // genuinely asymmetric rather than a guaranteed mutual kill.
  const lr = (): number => LAUNCH_RANGE * (0.45 + 0.5 * rnd());
  for (let i = 0; i < n; i++) {
    const base = (i - (n - 1) / 2) * spread;
    fighters.push({
      id: `A${i}`, team: 'A', name: nA[i]!,
      pos: vec(-9_000, base + (rnd() - 0.5) * 4_000),
      vel: vec(FIGHTER_SPEED, 0), alive: true, missiles: perF, cooldown: 0, launchRange: lr(),
    });
    fighters.push({
      id: `B${i}`, team: 'B', name: nB[i]!,
      pos: vec(9_000, base + (rnd() - 0.5) * 4_000),
      vel: vec(-FIGHTER_SPEED, 0), alive: true, missiles: perF, cooldown: 0, launchRange: lr(),
    });
  }

  const missiles: Missile[] = [];
  const events: CombatEvent[] = [];
  let mid = 0;
  let shots = 0;
  let hits = 0;
  const living = (team: Team): Fighter[] => fighters.filter((f) => f.alive && f.team === team);
  const byId = (id: string): Fighter | undefined => fighters.find((f) => f.id === id);

  let t = 0;
  let lastAction = 0; // time of the last fire/kill — for the stalemate cut
  for (; t <= maxTime; t += dt) {
    if (living('A').length === 0 || living('B').length === 0) break;
    // Ordnance expended and none in flight: the outcome is fixed — no
    // gun in this model, so unarmed survivors can't trade further.
    if (fighters.every((f) => !f.alive || f.missiles === 0) && missiles.every((m) => !m.alive)) break;
    // Stalemate: equal-energy survivors that never gain a firing solution
    // circle forever. With nothing in the air and no shot for a while,
    // call it — the engagement is resolved on numbers.
    if (t - lastAction > 35 && missiles.every((m) => !m.alive)) break;

    // ---- aircraft: pick target, evade incoming, else pursue + fire ----
    for (const f of fighters) {
      if (!f.alive) continue;
      f.cooldown = Math.max(0, f.cooldown - dt);
      const foes = living(other(f.team));
      if (foes.length === 0) continue;

      // Nearest incoming missile that is closing on us within threat range.
      let threat: Missile | null = null;
      let threatRange = THREAT_RANGE;
      for (const m of missiles) {
        if (!m.alive || m.team === f.team || m.target !== f.id) continue;
        const rel = sub(f.pos, m.pos); // missile → fighter
        const rng = norm(rel);
        // Closing when d/dt|rel| < 0, i.e. rel·(v_fighter − v_missile) < 0.
        if (rng < threatRange && dot(rel, sub(f.vel, m.vel)) < 0) {
          threat = m;
          threatRange = rng;
        }
      }

      const speed = norm(f.vel);
      const wRate = turnRate(FIGHTER_MAX_G, speed);
      let desired: Vec2;
      if (threat) {
        // Beam/break: turn to put the missile on the 3/9 line — velocity
        // perpendicular to the threat LOS bleeds its closing rate and
        // forces a high-line-of-sight-rate endgame it may not out-turn.
        const los = sub(f.pos, threat.pos);
        const b1 = perp(los);
        const b2 = scale(b1, -1);
        desired = dot(b1, f.vel) >= dot(b2, f.vel) ? b1 : b2;
        if (f.evadingFrom !== threat.id) {
          f.evadingFrom = threat.id; // one 'break' log per incoming missile
          events.push({ t, type: 'evade', by: f.name, from: byMissileShooter(threat) });
        }
      } else {
        f.evadingFrom = undefined;
        const tgt = nearest(f, foes);
        desired = sub(leadIntercept(f.pos, speed, tgt.pos, tgt.vel), f.pos);
      }
      f.vel = turnToward(f.vel, desired, wRate * dt);
      f.pos = add(f.pos, scale(f.vel, dt));

      // Fire: not evading, foe in the seeker cone and within range.
      if (!threat && f.missiles > 0 && f.cooldown <= 0) {
        const tgt = nearest(f, foes);
        const los = sub(tgt.pos, f.pos);
        const rng = norm(los);
        const off = Math.acos(Math.max(-1, Math.min(1, dot(los, f.vel) / (rng * norm(f.vel) || 1))));
        if (rng <= f.launchRange && off <= SEEKER_HALF_CONE) {
          missiles.push({
            id: `m${mid++}`, team: f.team, shooter: f.name,
            pos: { ...f.pos }, vel: { ...f.vel }, mass: MSL_LAUNCH_MASS,
            t0: t, target: tgt.id, alive: true,
          });
          f.missiles -= 1;
          f.cooldown = RELOAD_TIME;
          shots += 1;
          events.push({ t, type: 'fire', by: f.name, at: tgt.name, range: rng });
          lastAction = t;
        }
      }
    }

    // ---- missiles: PN homing, rocket boost + drag, lethality ----
    for (const m of missiles) {
      if (!m.alive) continue;
      const tgt = byId(m.target);
      if (!tgt || !tgt.alive) {
        m.alive = false;
        events.push({ t, type: 'miss', missile: m.id, target: byId(m.target)?.name ?? m.target, reason: 'target already down' });
        continue;
      }
      // Speed update: thrust (while grain remains) − drag, along vel.
      let speed = norm(m.vel);
      const burning = t - m.t0 < MSL_BURN;
      if (burning) {
        m.mass = Math.max(MSL_LAUNCH_MASS - MSL_GRAIN, m.mass - MSL_MDOT * dt);
      }
      const thrust = burning ? MSL_THRUST : 0;
      const drag = 0.5 * RHO_COMBAT * speed * speed * MSL_CD * MSL_AREA;
      speed = Math.max(0, speed + ((thrust - drag) / m.mass) * dt);
      // Heading update: proportional navigation, clamped to the airframe
      // lateral-g limit (ω = a_max/V = MSL_MAX_G·g/V).
      const maxTurn = (MSL_MAX_G * G0) / Math.max(speed, 1);
      const dir = norm(m.vel) > 1e-6 ? scale(m.vel, 1 / norm(m.vel)) : vec(1, 0);
      const steered = steerByProNav(m.pos, scale(dir, speed), tgt.pos, tgt.vel, dt, maxTurn);
      m.vel = norm(steered) > 1e-6 ? scale(steered, speed / norm(steered)) : scale(dir, speed);
      m.pos = add(m.pos, scale(m.vel, dt));

      // Terminal check: closest approach within this step vs lethal radius.
      const miss = segmentMiss(m.pos, sub(m.pos, scale(m.vel, dt)), tgt.pos, sub(tgt.pos, scale(tgt.vel, dt)));
      if (miss <= LETHAL_RADIUS) {
        m.alive = false;
        tgt.alive = false;
        hits += 1;
        events.push({ t, type: 'kill', missile: m.id, target: tgt.name, by: byMissileShooter(m) });
        lastAction = t;
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
  }

  const a = living('A').length;
  const b = living('B').length;
  const winner: Team | 'draw' = a > b ? 'A' : b > a ? 'B' : 'draw';
  events.push({ t, type: 'end', winner, survivorsA: a, survivorsB: b });
  return {
    events,
    winner,
    survivors: { A: living('A'), B: living('B') },
    duration: t,
    shots,
    hits,
  };
}

const byMissileShooter = (m: Missile): string => m.shooter;

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
