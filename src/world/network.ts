// Ground network and line-of-sight comms. Geometry only — no link
// budgets, no signal strength, no antenna pointing, no power, and no
// light-time delay (dropped deliberately: delay is realistic but needs
// scripting to be playable; prior art RemoteTech's configurable off).
//
// The world starts with EXACTLY ONE ground station, at the Cape. This
// is the central balance decision: the RemoteTech/CommNet experience is
// that a pre-seeded global network makes relay constellations pointless
// because coverage arrives free. Here everything past the first dish is
// something the player launched.
//
// Rules:
// - A surface station sees a target above its 5° elevation mask (NASA
//   Near Earth Network practice: 5–10° masks) unless the Moon blocks
//   the segment.
// - Space-to-space links need the segment clear of every body (this is
//   what makes far-side lunar operations demand a relay).
// - A relay node is ONLINE if it has line-of-sight to a station or to
//   another online relay (bent-pipe chaining, breadth-first).
// - Aircraft (plane class) inside an atmosphere are exempt: sorties are
//   piloted from the cockpit. The link rule models UNCREWED spacecraft
//   command — RemoteTech's crewed exemption, with the plane class as
//   this sim's crew stand-in.
//
// All geometry is evaluated in the Earth-centered sim plane at a given
// world time; Moon-frame objects are converted through the ephemeris.

import { BODIES, bodyById, bodyOrbitState } from '../physics/bodies';
import { Vec2, add, dot, norm, scale, sub, vec } from '../physics/vec2';

export interface GroundStation {
  id: string;
  name: string;
  body: string;
  /** Surface-fixed angle at t = 0 [rad]. */
  angle: number;
}

/** The one starting station, co-located with the Cape complex. */
export const GROUND_STATIONS: readonly GroundStation[] = [
  { id: 'gs-1', name: 'Cape Ground Station', body: 'earth', angle: 0 },
];

/** Elevation mask [rad] — NASA NEN-class 5°. */
export const ELEVATION_MASK = (5 * Math.PI) / 180;

/** Earth-frame position of a body-relative point at time t. */
export function earthFrame(body: string, r: Vec2, t: number): Vec2 {
  if (body === 'earth') return r;
  const b = bodyById(body);
  if (!b.orbit) return r;
  return add(bodyOrbitState(b, t).r, r);
}

export function stationPos(st: GroundStation, t: number): Vec2 {
  const b = bodyById(st.body);
  const a = st.angle + b.rotationRate * t;
  return scale(vec(Math.cos(a), Math.sin(a)), b.radius);
}

/** Occluding bodies (earth-frame circles) at time t. */
export function occluders(t: number): { id: string; c: Vec2; radius: number }[] {
  return BODIES.map((b) => ({
    id: b.id,
    c: b.parent ? bodyOrbitState(b, t).r : vec(0, 0),
    radius: b.radius,
  }));
}

/** Segment a—b clear of every occluding circle. Endpoints may sit ON a
 * surface (a station): points within 1 m of a circle are treated as
 * boundary, not blocked. */
export function losClear(a: Vec2, b: Vec2, occ: { c: Vec2; radius: number }[]): boolean {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  for (const o of occ) {
    const ac = sub(o.c, a);
    const u = len2 > 0 ? Math.max(0, Math.min(1, dot(ac, ab) / len2)) : 0;
    const closest = sub(ac, scale(ab, u));
    if (norm(closest) < o.radius - 1) return false;
  }
  return true;
}

/** Does station st see earth-frame point p at time t? Elevation above
 * the mask (which subsumes the station's own horizon), plus the segment
 * clear of every OTHER body. */
export function stationSees(st: GroundStation, p: Vec2, t: number): boolean {
  const s = stationPos(st, t);
  const up = scale(s, 1 / norm(s));
  const d = sub(p, s);
  const dn = norm(d);
  if (dn < 1) return true; // on the pad next to the dish
  if (dot(d, up) / dn < Math.sin(ELEVATION_MASK)) return false;
  // The home body cannot block a segment above the elevation mask;
  // every OTHER body (the Moon) can.
  return losClear(s, p, occluders(t).filter((o) => o.id !== st.body));
}

export interface LinkResult {
  linked: boolean;
  /** First hop of the serving path (earth frame), for drawing. */
  via: Vec2 | null;
  viaName: string;
}

/**
 * Is the earth-frame point p commandable at time t, given relay nodes?
 * Breadth-first: stations are roots; a relay is online if it sees a
 * station or an online relay; p is linked if it sees a station or an
 * online relay.
 */
export function hasLink(
  p: Vec2,
  t: number,
  relays: { pos: Vec2; name: string }[],
): LinkResult {
  const occ = occluders(t);
  for (const st of GROUND_STATIONS) {
    if (stationSees(st, p, t)) return { linked: true, via: stationPos(st, t), viaName: st.name };
  }
  // Relay availability by BFS from the stations.
  const online = new Array<boolean>(relays.length).fill(false);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < relays.length; i++) {
      if (online[i]) continue;
      const r = relays[i]!;
      let up = GROUND_STATIONS.some((st) => stationSees(st, r.pos, t));
      if (!up) {
        up = relays.some((o, j) => j !== i && online[j] && losClear(r.pos, o.pos, occ));
      }
      if (up) {
        online[i] = true;
        grew = true;
      }
    }
  }
  for (let i = 0; i < relays.length; i++) {
    if (online[i] && losClear(p, relays[i]!.pos, occ)) {
      return { linked: true, via: relays[i]!.pos, viaName: relays[i]!.name };
    }
  }
  return { linked: false, via: null, viaName: '' };
}

/** Continuous-coverage constellation geometry (the planner's math): N
 * evenly spaced satellites at altitude h cover the whole surface (above
 * the elevation mask ε) iff the per-satellite half-footprint
 *     λ = acos(R·cosε/(R+h)) − ε
 * reaches π/N (standard single-plane street-of-coverage relation —
 * Wertz, "Space Mission Analysis and Design", §5.3, specialized to the
 * planar world's one orbital plane). */
export function coverageHalfAngle(h: number, bodyRadius: number, mask = ELEVATION_MASK): number {
  const x = (bodyRadius * Math.cos(mask)) / (bodyRadius + h);
  return Math.acos(Math.min(1, x)) - mask;
}

/** Minimum altitude for N satellites to give continuous coverage. */
export function constellationAltitude(n: number, bodyRadius: number, mask = ELEVATION_MASK): number {
  if (n < 2) return Infinity;
  const lam = Math.PI / n;
  // Invert λ(h): R+h = R·cosε/cos(λ+ε); no solution once λ+ε ≥ π/2.
  if (lam + mask >= Math.PI / 2) return Infinity;
  return (bodyRadius * Math.cos(mask)) / Math.cos(lam + mask) - bodyRadius;
}
