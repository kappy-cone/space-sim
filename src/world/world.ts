// The persistent world: a registry of objects in orbit, site status,
// terrain reveal, and the world clock. Everything the sim accumulates
// between flights lives here — a launch is an entry in a program, not an
// isolated sandbox run.
//
// THE SESSION-MODEL GATE (load-bearing): this state is only ever written
// by (a) a committed flight being harvested at its end, or (b) an
// explicit world-clock advance. Test flights never construct a world
// context and write nothing — no registry entries, no debris, no site
// wear. The Sim itself never reads world state, so a fresh save with an
// empty world behaves exactly as the sim does with no world at all (the
// golden fixtures pin this).
//
// Registry objects are body-relative state vectors at a world epoch,
// propagated ANALYTICALLY on demand (universal-variable Kepler) — never
// continuously, never for objects nothing is querying. Two-body only.
// The one exception is the world-clock advance, where atmospheric drag
// (decay.ts, orbit-averaged) walks low-perigee orbits down and removes
// what reenters — physically correct, and the garbage collector that
// keeps the registry bounded.

import { EARTH, bodyById, bodyOrbitState } from '../physics/bodies';
import { SITES, siteById } from '../physics/sites';
import { hasLink } from './network';
import { Elements, elementsFromState, propagateKepler } from '../physics/kepler';
import { Vec2, vec } from '../physics/vec2';
import { G0 } from '../physics/constants';
import { REENTRY_FLOOR, advanceDecay, perOrbitDrag } from './decay';

export const WORLD_VERSION = 1;
export const WORLD_STORAGE_KEY = 'space-sim.world';

/** Station-keeping Isp [s]: storable-RCS class — the same estimate the
 * flight sim's RCS drain uses (see sim.ts), kept identical on purpose. */
export const STATIONKEEPING_ISP = 300;

/** Terrain reveal resolution: 1440 bins of 0.25° ≈ 27.8 km of arc at the
 * Earth's equator — commensurate with a site's footprint. */
export const REVEAL_BINS = 1440;

/** Imaging ceiling for survey satellites [m]: above this the take is
 * useless (GSD scales with altitude; Landsat flies 705 km, SPOT 822 km
 * — see the Survey Module part). This is what makes survey want a LOW
 * orbit. */
export const SURVEY_CEILING = 900_000;

/** Aircraft overflight reveal ceiling [m]: low flight maps what it
 * flies over (class value — visual/radar mapping altitude). */
export const OVERFLIGHT_ALT = 10_000;

export type ObjectKind = 'satellite' | 'debris' | 'vessel';
export type SatelliteFunc = 'relay' | 'survey' | 'tug';

export interface SpaceObject {
  id: string;
  name: string;
  kind: ObjectKind;
  /** Function module aboard (satellites only). */
  func?: SatelliteFunc;
  /** Reference body id (patched-conic frame the state vector lives in). */
  body: string;
  /** Body-relative state vector in the sim plane at world time t0. */
  r: [number, number];
  v: [number, number];
  t0: number;
  /** Total on-orbit mass [kg] (dry + residual propellant). */
  mass: number;
  /** Station-keeping propellant [kg] within `mass`; burned to hold the
   * orbit against drag (Isp 300 s class). Zero for debris. */
  skProp: number;
  /** Drag reference Cd·A [m²] for decay (tumbling mean — class value). */
  cdA: number;
  /** Owning committed launch number. */
  launch: number;
}

export interface SiteState {
  discovered: boolean;
  active: boolean;
  /** World time until which the pad/runway is out of service [s]. */
  wearUntil: number;
}

export type WorldEvent =
  | { type: 'reentry'; t: number; id: string; name: string }
  | { type: 'skDepleted'; t: number; id: string; name: string }
  | { type: 'launch'; t: number; n: number; site: string; name: string }
  | { type: 'deployed'; t: number; id: string; name: string; func?: SatelliteFunc }
  | { type: 'debris'; t: number; id: string; name: string }
  | { type: 'rangeViolation'; t: number; site: string }
  | { type: 'siteDiscovered'; t: number; site: string }
  | { type: 'siteActivated'; t: number; site: string }
  | { type: 'deorbited'; t: number; id: string; name: string }
  | { type: 'missionComplete'; t: number; id: string; title: string }
  | { type: 'missionExpired'; t: number; id: string; title: string };

export interface WorldState {
  version: number;
  /** World clock [s]. Advances only with committed flights and explicit
   * clock advances. Flights launch AT this epoch (moon phase and site
   * rotation stay continuous across a program). */
  epoch: number;
  /** Committed launches flown (id counter and mission-generator seed). */
  launches: number;
  objects: SpaceObject[];
  sites: Record<string, SiteState>;
  /** Terrain reveal bitfield, hex-encoded, REVEAL_BINS bins over the
   * Earth's surface angle [0, 2π). */
  revealed: string;
  /** Capped history of world events (newest last) for the tracking view. */
  log: WorldEvent[];
}

const LOG_CAP = 200;

export function emptyWorld(): WorldState {
  return {
    version: WORLD_VERSION,
    epoch: 0,
    launches: 0,
    objects: [],
    sites: {},
    revealed: '0'.repeat(Math.ceil(REVEAL_BINS / 4)),
    log: [],
  };
}

export function serializeWorld(w: WorldState): string {
  return JSON.stringify(w);
}

/** Parse and migrate a saved world. Unknown future versions throw rather
 * than guess; a corrupt save returns null so callers can start fresh
 * without destroying the stored string (the .bak pattern). */
export function deserializeWorld(json: string): WorldState | null {
  let w: WorldState;
  try {
    w = JSON.parse(json) as WorldState;
  } catch {
    return null;
  }
  if (typeof w !== 'object' || w === null || typeof w.version !== 'number') return null;
  if (w.version > WORLD_VERSION) throw new Error(`world save version ${w.version} is newer than this build`);
  // version 1 is current — future migrations switch on w.version here.
  return w;
}

export function pushLog(w: WorldState, ev: WorldEvent): void {
  w.log.push(ev);
  if (w.log.length > LOG_CAP) w.log.splice(0, w.log.length - LOG_CAP);
}

// ---------- registry propagation (on demand, analytic) ----------

/** Body-relative state of a registry object at world time t. Exact
 * two-body propagation from the stored epoch state — a pure read. */
export function objectStateAt(o: SpaceObject, t: number): { r: Vec2; v: Vec2 } {
  const mu = bodyById(o.body).mu;
  return propagateKepler(vec(o.r[0], o.r[1]), vec(o.v[0], o.v[1]), t - o.t0, mu);
}

export function objectElements(o: SpaceObject): Elements {
  return elementsFromState(vec(o.r[0], o.r[1]), vec(o.v[0], o.v[1]), bodyById(o.body).mu);
}

/** Orbit is closed and clear of the reentry floor — the registry
 * admission rule (anything else falls back or escapes within the flight
 * that made it). */
export function orbitPersists(el: Elements, bodyId: string): boolean {
  const b = bodyById(bodyId);
  const floor = b.atmosphere ? REENTRY_FLOOR : 0;
  return el.e < 1 && el.rPeri > b.radius + floor;
}

// ---------- state ↔ elements (planar) ----------

/** Rebuild a planar state vector from mean elements: semi-major axis,
 * eccentricity, argument of periapsis, direction (sign of h), and true
 * anomaly. Standard conic relations (Curtis, "Orbital Mechanics" ch. 2):
 * r = p/(1+e·cosν), v_r = (μ/h)·e·sinν, v_t = h/r. */
export function stateFromElements(
  a: number,
  e: number,
  argPeri: number,
  dir: 1 | -1,
  nu: number,
  mu: number,
): { r: Vec2; v: Vec2 } {
  const p = a * (1 - e * e);
  const h = Math.sqrt(mu * p);
  const rMag = p / (1 + e * Math.cos(nu));
  const phi = argPeri + dir * nu;
  const rHat = vec(Math.cos(phi), Math.sin(phi));
  const tHat = vec(-dir * Math.sin(phi), dir * Math.cos(phi)); // dir·perp(r̂)
  const vr = (mu / h) * e * Math.sin(nu);
  const vt = h / rMag;
  return {
    r: vec(rHat.x * rMag, rHat.y * rMag),
    v: vec(rHat.x * vr + tHat.x * vt, rHat.y * vr + tHat.y * vt),
  };
}

/** Solve Kepler's equation M = E − e·sinE by Newton iteration
 * (elliptic; standard, e.g. Vallado alg. 2). */
export function solveKepler(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

// ---------- world-clock advance (decay + station-keeping) ----------

/**
 * Advance the world clock by dt seconds. Low-perigee objects decay
 * (orbit-averaged drag); satellites with station-keeping propellant buy
 * the drag Δv back (ṁ from the rocket equation at Isp 300 s) until the
 * tank runs dry; what reaches the reentry floor is removed and logged.
 * Objects clear of the atmosphere are NOT touched — their stored epoch
 * state stays exact and is propagated only when someone asks.
 */
export function advanceWorld(w: WorldState, dt: number): WorldEvent[] {
  const t1 = w.epoch + dt;
  const events: WorldEvent[] = [];
  const survivors: SpaceObject[] = [];
  for (const o of w.objects) {
    const body = bodyById(o.body);
    if (!body.atmosphere) {
      survivors.push(o);
      continue; // airless primary: no drag, no decay
    }
    const el = objectElements(o);
    if (el.e >= 1) {
      // Escaping object: it leaves the SOI within the advance in any
      // realistic case — drop it (simplification: hyperbolic registry
      // entries are not tracked across SOI boundaries).
      events.push({ type: 'reentry', t: w.epoch, id: o.id, name: `${o.name} (escaped)` });
      continue;
    }
    const periAlt = el.rPeri - body.radius;
    if (periAlt > 1_000_000) {
      survivors.push(o); // above the density table: exact, untouched
      continue;
    }
    let remaining = dt;
    let tNow = w.epoch;
    let alive = true;
    let a = el.a;
    let e = el.e;
    let decayed = false;
    const cdAOverM = o.cdA / o.mass;
    // Station-keeping first: buy back the drag Δv while propellant lasts.
    if (o.skProp > 0) {
      const per = perOrbitDrag(a, e, body.mu, body.radius);
      const T = 2 * Math.PI * Math.sqrt((a * a * a) / body.mu);
      const dvPerSec = (per.dv * cdAOverM) / T;
      const mdot = (o.mass * dvPerSec) / (G0 * STATIONKEEPING_ISP); // ≈ linearized rocket eq.
      const tHold = mdot > 0 ? o.skProp / mdot : remaining;
      const held = Math.min(remaining, tHold);
      const spent = mdot * held;
      o.skProp = Math.max(0, o.skProp - spent);
      o.mass -= spent;
      remaining -= held;
      tNow += held;
      if (remaining > 0 && o.skProp <= 0.01) {
        events.push({ type: 'skDepleted', t: tNow, id: o.id, name: o.name });
      }
    }
    if (remaining > 0) {
      const res = advanceDecay({ a, e }, cdAOverM, remaining, body.mu, body.radius);
      if (res.reentered) {
        events.push({ type: 'reentry', t: tNow + res.tUsed, id: o.id, name: o.name });
        alive = false;
      } else {
        decayed = res.a !== a || res.e !== e;
        a = res.a;
        e = res.e;
      }
    }
    if (alive) {
      if (decayed) {
        // Rebuild the epoch state from the decayed mean elements. The
        // in-orbit phase is advanced by the mean motion of the NEW orbit
        // (flagged approximation — true phase through a decay arc is not
        // analytically recoverable, and no gameplay reads it to better
        // than an orbit).
        const dir: 1 | -1 = el.h >= 0 ? 1 : -1;
        const E0 = 2 * Math.atan2(
          Math.sqrt(1 - e) * Math.sin(el.nu / 2),
          Math.sqrt(1 + e) * Math.cos(el.nu / 2),
        );
        const n = Math.sqrt(body.mu / (a * a * a));
        const M = E0 - e * Math.sin(E0) + n * dt;
        const E = solveKepler(((M + Math.PI) % (2 * Math.PI)) - Math.PI, e);
        const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
        const s = stateFromElements(a, e, el.argPeri, dir, nu, body.mu);
        o.r = [s.r.x, s.r.y];
        o.v = [s.v.x, s.v.y];
        o.t0 = t1;
      }
      // Undecayed objects keep their exact stored state — t0 untouched.
      survivors.push(o);
    }
  }
  w.objects = survivors;
  w.epoch = t1;
  for (const ev of events) pushLog(w, ev);

  // ---- survey reveal ----
  // A survey satellite reveals the terrain directly beneath it while it
  // is (a) under the imaging ceiling and (b) LINKED to the network —
  // no onboard storage is modeled (simplification, flagged), which is
  // exactly what couples survey coverage to the relay constellation:
  // with only the Cape station, only the arc around the Cape ever gets
  // imaged. Sampled at 60 s (a LEO ground track moves ~4°/min, well
  // over the 0.25° bin size but continuous arcs are swept between
  // consecutive linked samples).
  const surveys = w.objects.filter((o) => o.func === 'survey' && o.body === 'earth');
  if (surveys.length > 0 && dt > 0) {
    const relays = w.objects.filter((o) => o.func === 'relay');
    const relayPos = (t: number) =>
      relays.map((o) => {
        const s = objectStateAt(o, t);
        const b = bodyById(o.body);
        const off = b.parent && b.orbit ? bodyOrbitState(b, t).r : null;
        return { pos: off ? { x: s.r.x + off.x, y: s.r.y + off.y } : s.r, name: o.name };
      });
    const wrapSigned = (x: number): number => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const step = 60;
    for (const o of surveys) {
      let prevSigma: number | null = null;
      for (let t = t1 - dt; t <= t1; t += step) {
        const s = objectStateAt(o, t);
        const rn = Math.hypot(s.r.x, s.r.y);
        if (rn - EARTH.radius > SURVEY_CEILING || !hasLink(s.r, t, relayPos(t)).linked) {
          prevSigma = null;
          continue;
        }
        const sigma = Math.atan2(s.r.y, s.r.x) - EARTH.rotationRate * t;
        if (prevSigma !== null) revealArc(w, prevSigma, wrapSigned(sigma - prevSigma));
        prevSigma = sigma;
      }
    }
  }
  events.push(...checkSiteDiscoveries(w, t1)); // already logged by discoverSite
  return events;
}

/** Sites sitting on revealed terrain become DISCOVERED (they still need
 * an activation flight to be usable). */
export function checkSiteDiscoveries(w: WorldState, t: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (const s of SITES) {
    if (s.body !== 'earth') continue;
    if (!siteState(w, s.id).discovered && isRevealed(w, s.angle)) {
      out.push(...discoverSite(w, s.id, t));
    }
  }
  return out;
}

// ---------- sites ----------

/** Site status — a pure read: unmutated worlds report the static
 * default (home complex discovered, everything else hidden). */
export function siteState(w: WorldState, id: string): SiteState {
  const s = w.sites[id];
  if (s) return s;
  const def = siteById(id);
  return { discovered: def.startsDiscovered, active: def.startsDiscovered, wearUntil: 0 };
}

/** Usable for a committed launch right now. */
export function siteAvailable(w: WorldState, id: string): boolean {
  const s = siteState(w, id);
  return s.discovered && s.active && s.wearUntil <= w.epoch;
}

export function discoverSite(w: WorldState, id: string, t: number): WorldEvent[] {
  const s = siteState(w, id);
  if (s.discovered) return [];
  w.sites[id] = { ...s, discovered: true };
  const ev: WorldEvent = { type: 'siteDiscovered', t, site: id };
  pushLog(w, ev);
  return [ev];
}

/** Activate a site (cargo delivery landed): discovers it too, and builds
 * out the pad the runway serves, if any. */
export function activateSite(w: WorldState, id: string, t: number): WorldEvent[] {
  const events = discoverSite(w, id, t);
  const s = siteState(w, id);
  if (!s.active) {
    w.sites[id] = { ...s, discovered: true, active: true };
    const ev: WorldEvent = { type: 'siteActivated', t, site: id };
    pushLog(w, ev);
    events.push(ev);
  }
  const pad = siteById(id).activatesPad;
  if (pad) events.push(...activateSite(w, pad, t));
  return events;
}

export function applyWear(w: WorldState, id: string, seconds: number, from: number): void {
  const s = siteState(w, id);
  w.sites[id] = { ...s, wearUntil: Math.max(s.wearUntil, from + seconds) };
}

/** Pad refurbishment time scales with liftoff thrust — acoustic and
 * thermal damage do (class values, ESTIMATE: modern F9-class pads turn
 * around in days; heavy vehicles historically took weeks). This is the
 * quiet reward for gentler vehicles. */
export function padWearSeconds(liftoffThrustN: number): number {
  return 86_400 * (1 + 0.8 * (liftoffThrustN / 1e6));
}

/** Runway wear: a nominal cycle is light; a HARD touchdown (sink rate
 * above 70% of the 14 CFR 25.473 design limit) closes the strip for
 * inspection (class values, ESTIMATE). */
export function runwayWearSeconds(hardLanding: boolean): number {
  return 86_400 * (hardLanding ? 2 : 0.25);
}

// ---------- terrain reveal ----------

const wrapAngle = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function bits(w: WorldState): Uint8Array {
  const out = new Uint8Array(Math.ceil(REVEAL_BINS / 8));
  for (let i = 0; i < w.revealed.length; i++) {
    const nib = parseInt(w.revealed[i]!, 16) || 0;
    out[i >> 1] = (out[i >> 1]! | (i % 2 === 0 ? nib << 4 : nib)) & 0xff;
  }
  return out;
}

function storeBits(w: WorldState, b: Uint8Array): void {
  let s = '';
  for (let i = 0; i < Math.ceil(REVEAL_BINS / 4); i++) {
    const nib = i % 2 === 0 ? b[i >> 1]! >> 4 : b[i >> 1]! & 0xf;
    s += nib.toString(16);
  }
  w.revealed = s;
}

export function isRevealed(w: WorldState, surfaceAngle: number): boolean {
  const bin = Math.floor((wrapAngle(surfaceAngle) / (2 * Math.PI)) * REVEAL_BINS) % REVEAL_BINS;
  const b = bits(w);
  return (b[bin >> 3]! & (1 << (bin & 7))) !== 0;
}

/** Reveal the surface arc from a0 sweeping by da (either sign). */
export function revealArc(w: WorldState, a0: number, da: number): void {
  const b = bits(w);
  const steps = Math.min(REVEAL_BINS, Math.ceil((Math.abs(da) / (2 * Math.PI)) * REVEAL_BINS) + 1);
  for (let i = 0; i <= steps; i++) {
    const ang = a0 + (Math.sign(da) * i * 2 * Math.PI) / REVEAL_BINS;
    const bin = Math.floor((wrapAngle(ang) / (2 * Math.PI)) * REVEAL_BINS) % REVEAL_BINS;
    b[bin >> 3] = (b[bin >> 3]! | (1 << (bin & 7))) & 0xff;
  }
  storeBits(w, b);
}

/** Reveal specific bins directly (aircraft overflight tracks collected
 * during a committed flight). */
export function revealBins(w: WorldState, binsToSet: Iterable<number>): void {
  const b = bits(w);
  for (const bin of binsToSet) {
    const i = ((bin % REVEAL_BINS) + REVEAL_BINS) % REVEAL_BINS;
    b[i >> 3] = (b[i >> 3]! | (1 << (i & 7))) & 0xff;
  }
  storeBits(w, b);
}

/** Bin index for a surface angle. */
export function binOf(surfaceAngle: number): number {
  return Math.floor((wrapAngle(surfaceAngle) / (2 * Math.PI)) * REVEAL_BINS) % REVEAL_BINS;
}

export function revealedFraction(w: WorldState): number {
  const b = bits(w);
  let n = 0;
  for (let bin = 0; bin < REVEAL_BINS; bin++) {
    if ((b[bin >> 3]! & (1 << (bin & 7))) !== 0) n++;
  }
  return n / REVEAL_BINS;
}
