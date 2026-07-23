// Proportional navigation — the real homing-missile guidance law.
//
// PN commands lateral acceleration proportional to the line-of-sight
// (LOS) rotation rate and the closing velocity:
//     a_cmd = N · Vc · λ̇        (perpendicular to the LOS)
// where N is the navigation constant (3–5 in practice; 4 here), Vc the
// closing speed, and λ̇ the LOS angular rate. Nulling λ̇ holds the target
// on a constant bearing — the collision-course condition every sailor
// and every heat-seeker uses. Reference: Zarchan, "Tactical and
// Strategic Missile Guidance" (AIAA), ch. 2; the same true-PN law flown
// by Sidewinder-class seekers.
//
// This is a planar 2-D formulation for the top-down dogfight model
// (src/combat/dogfight.ts) — deliberately separate from the vertical
// orbital-plane Sim, which has no azimuth to turn in.

import { Vec2, cross, dot, norm, scale, sub } from '../physics/vec2';

export const NAV_CONSTANT = 4; // N — mid of the 3–5 practical range

/**
 * PN lateral acceleration command [m/s²] for a missile at (rM, vM)
 * homing on a target at (rT, vT). The magnitude is |a| and it acts
 * perpendicular to the missile velocity, turning it toward a collision
 * course; sign follows the LOS rotation. Returns 0 when opening
 * (Vc ≤ 0) — a missile that can't close doesn't waste turn authority.
 */
export function proNavAccel(rM: Vec2, vM: Vec2, rT: Vec2, vT: Vec2, n = NAV_CONSTANT): number {
  const rRel = sub(rT, rM); // LOS vector, missile→target
  const vRel = sub(vT, vM);
  const range = norm(rRel);
  if (range < 1e-6) return 0;
  // Closing velocity: −d(range)/dt = −(rRel·vRel)/range.
  const closing = -dot(rRel, vRel) / range;
  if (closing <= 0) return 0; // target opening — PN gives no command
  // LOS rate λ̇ = (rRel × vRel) / range²  (z-component; planar).
  const losRate = cross(rRel, vRel) / (range * range);
  return n * closing * losRate;
}

/**
 * Turn the PN acceleration command into a new heading for a
 * speed-holding missile over dt: Δψ = a_cmd·dt / V (small-angle turn at
 * constant speed), clamped to the airframe's structural turn limit.
 * Returns the updated velocity vector (magnitude preserved).
 */
export function steerByProNav(
  rM: Vec2,
  vM: Vec2,
  rT: Vec2,
  vT: Vec2,
  dt: number,
  maxTurnRate: number,
  n = NAV_CONSTANT,
): Vec2 {
  const speed = norm(vM);
  if (speed < 1e-6) return vM;
  const aCmd = proNavAccel(rM, vM, rT, vT, n);
  let dPsi = (aCmd / speed) * dt;
  const cap = maxTurnRate * dt;
  if (dPsi > cap) dPsi = cap;
  else if (dPsi < -cap) dPsi = -cap;
  const c = Math.cos(dPsi);
  const s = Math.sin(dPsi);
  return { x: vM.x * c - vM.y * s, y: vM.x * s + vM.y * c };
}

/**
 * Lead-collision intercept point for pursuit steering (aircraft AI):
 * where a constant-velocity target will be when a pursuer at speed
 * `pursuerSpeed` could reach it — the quadratic time-to-go solution.
 * Returns the target's current position if no closing solution exists
 * (pursuer too slow), which degrades gracefully to pure pursuit.
 */
export function leadIntercept(rP: Vec2, pursuerSpeed: number, rT: Vec2, vT: Vec2): Vec2 {
  const d = sub(rT, rP);
  const a = dot(vT, vT) - pursuerSpeed * pursuerSpeed;
  const b = 2 * dot(d, vT);
  const c = dot(d, d);
  let tGo: number;
  if (Math.abs(a) < 1e-6) {
    tGo = Math.abs(b) > 1e-6 ? -c / b : 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return rT; // no intercept — chase the current position
    const sq = Math.sqrt(disc);
    const t1 = (-b + sq) / (2 * a);
    const t2 = (-b - sq) / (2 * a);
    tGo = Math.min(...[t1, t2].filter((t) => t > 0), Infinity);
    if (!isFinite(tGo)) return rT;
  }
  return { x: rT.x + vT.x * tGo, y: rT.y + vT.y * tGo };
}
