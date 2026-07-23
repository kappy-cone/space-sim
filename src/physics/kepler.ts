// Analytic two-body orbit mechanics.
//
// Coast arcs are propagated with the universal-variable Kepler solution
// (valid for elliptic, parabolic and hyperbolic orbits) — never numerically
// integrated, so a coast of any length is exact to machine precision.
// Reference: Vallado, "Fundamentals of Astrodynamics and Applications",
// 4th ed., Algorithm 8 (KEPLER, universal variables) and Curtis, "Orbital
// Mechanics for Engineering Students", ch. 3 (f and g functions).

import { Vec2, add, cross, dot, norm, scale, sub } from './vec2';
import { MU_EARTH } from './constants';

/** Stumpff function C(z) = (1 − cos√z)/z, extended to z ≤ 0. */
export function stumpffC(z: number): number {
  if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  // Series about z = 0: 1/2 − z/24 + z²/720
  return 1 / 2 - z / 24 + (z * z) / 720;
}

/** Stumpff function S(z) = (√z − sin√z)/√z³, extended to z ≤ 0. */
export function stumpffS(z: number): number {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  // Series about z = 0: 1/6 − z/120 + z²/5040
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

/**
 * Propagate (r0, v0) forward by dt seconds under two-body gravity.
 * Universal-variable formulation with f and g functions — exact for any
 * conic, any dt (positive or negative).
 */
export function propagateKepler(
  r0: Vec2,
  v0: Vec2,
  dt: number,
  mu: number = MU_EARTH,
): { r: Vec2; v: Vec2 } {
  if (dt === 0) return { r: r0, v: v0 };
  const sqrtMu = Math.sqrt(mu);
  const r0n = norm(r0);
  const vr0 = dot(r0, v0) / r0n; // radial velocity component
  const alpha = 2 / r0n - dot(v0, v0) / mu; // 1/a (>0 ellipse, <0 hyperbola)

  // Initial guess for the universal anomaly χ (Vallado alg. 8 / Curtis eq. 3.66).
  let chi: number;
  if (alpha > 1e-12) {
    chi = sqrtMu * alpha * dt; // elliptic
  } else if (alpha < -1e-12) {
    const a = 1 / alpha;
    chi =
      Math.sign(dt) *
      Math.sqrt(-a) *
      Math.log(
        (-2 * mu * alpha * dt) /
          (dot(r0, v0) + Math.sign(dt) * sqrtMu * Math.sqrt(-a) * (1 - r0n * alpha)),
      );
  } else {
    chi = (sqrtMu * dt) / r0n; // near-parabolic
  }

  // Newton iteration on the universal Kepler equation.
  for (let i = 0; i < 60; i++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F =
      ((r0n * vr0) / sqrtMu) * chi * chi * C +
      (1 - alpha * r0n) * chi * chi * chi * S +
      r0n * chi -
      sqrtMu * dt;
    const dF =
      ((r0n * vr0) / sqrtMu) * chi * (1 - z * S) +
      (1 - alpha * r0n) * chi * chi * C +
      r0n;
    const dChi = F / dF;
    chi -= dChi;
    if (Math.abs(dChi) < 1e-10) break;
  }

  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - ((chi * chi) / r0n) * C;
  const g = dt - (chi * chi * chi * S) / sqrtMu;
  const r = add(scale(r0, f), scale(v0, g));
  const rn = norm(r);
  const fdot = (sqrtMu / (rn * r0n)) * chi * (z * S - 1);
  const gdot = 1 - ((chi * chi) / rn) * C;
  const v = add(scale(r0, fdot), scale(v0, gdot));
  return { r, v };
}

/** Osculating orbital elements + derived readouts, from a 2D state. */
export interface Elements {
  /** Semi-major axis [m]; negative for hyperbolic. */
  a: number;
  /** Eccentricity. */
  e: number;
  /** Specific orbital energy [J/kg] = −μ/2a. */
  energy: number;
  /** Specific angular momentum z-component [m²/s]; sign = orbit direction. */
  h: number;
  /** Apoapsis radius [m] from center; Infinity when e ≥ 1. */
  rApo: number;
  /** Periapsis radius [m] from center. */
  rPeri: number;
  /** Orbital period [s]; Infinity when not bound. */
  period: number;
  /** True anomaly [rad], in (−π, π]. */
  nu: number;
  /** Seconds until next apoapsis passage; NaN when not bound. */
  timeToApo: number;
  /** Seconds until next periapsis passage; NaN when not bound. */
  timeToPeri: number;
  /** Argument of periapsis in the plane [rad] (angle of the e-vector). */
  argPeri: number;
}

export function elementsFromState(r: Vec2, v: Vec2, mu: number = MU_EARTH): Elements {
  const rn = norm(r);
  const v2 = dot(v, v);
  const energy = v2 / 2 - mu / rn;
  const h = cross(r, v); // planar: scalar angular momentum
  // Eccentricity vector (planar): e = (v × h)/μ − r̂  with h = h ẑ
  // v × (h ẑ) = (vy·h, −vx·h)
  const eVec: Vec2 = {
    x: (v.y * h) / mu - r.x / rn,
    y: (-v.x * h) / mu - r.y / rn,
  };
  const e = norm(eVec);
  const a = -mu / (2 * energy); // negative for hyperbolic
  const rPeri = e < 1 ? a * (1 - e) : (h * h) / mu / (1 + e);
  const rApo = e < 1 ? a * (1 + e) : Infinity;
  const bound = energy < 0;
  const period = bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;

  // True anomaly: angle from e-vector to r, signed by direction of motion.
  let nu: number;
  if (e > 1e-11) {
    nu = Math.atan2(cross(eVec, r), dot(eVec, r));
  } else {
    nu = 0; // circular: measure from current position; time-to-apo meaningless anyway
  }
  // For a retrograde orbit (h < 0) the anomaly grows opposite the geometric
  // angle; flip so ν always increases with time.
  if (h < 0) nu = -nu;

  let timeToApo = NaN;
  let timeToPeri = NaN;
  if (bound && e > 1e-11) {
    // Eccentric anomaly from true anomaly, then Kepler's equation M = E − e·sinE.
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const M = E - e * Math.sin(E); // in (−π, π]
    const n = Math.sqrt(mu / (a * a * a)); // mean motion
    const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    timeToPeri = wrap(-M) / n; // periapsis is at M = 0 (mod 2π)
    timeToApo = wrap(Math.PI - M) / n; // apoapsis is at M = π
  }

  return {
    a,
    e,
    energy,
    h,
    rApo,
    rPeri,
    period,
    nu,
    timeToApo,
    timeToPeri,
    argPeri: Math.atan2(eVec.y, eVec.x),
  };
}
