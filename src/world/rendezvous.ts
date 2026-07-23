// Intercept instrumentation for tug flights: closest approach between
// the vessel's current conic and a registry object, both propagated
// with the same universal-variable Kepler the sim coasts on. Pure
// two-body prediction — honest exactly when the tug is coasting, which
// is when the reading matters.
//
// Capture itself is an abstraction (flagged in the part source): within
// CAPTURE_RANGE under CAPTURE_SPEED the grapple takes hold — prior art
// KSP's claw; real servicing vehicles (MEV-1) close the last meters at
// cm/s with proximity-ops tooling this sim does not model.

import { propagateKepler } from '../physics/kepler';
import { Vec2, norm, sub } from '../physics/vec2';
import { bodyById } from '../physics/bodies';
import { SpaceObject, objectStateAt } from './world';

export const CAPTURE_RANGE = 250; // m
export const CAPTURE_SPEED = 5; // m/s relative

export interface Approach {
  /** Seconds from now to the closest approach. */
  dt: number;
  /** Separation at closest approach [m]. */
  dist: number;
  /** Relative speed at closest approach [m/s]. */
  relSpeed: number;
}

/**
 * Closest approach over the next `horizon` seconds: 256-point coarse
 * sample refined by ternary search in the bracketing interval. Both
 * trajectories are exact conics — no integration.
 */
export function closestApproach(
  rSelf: Vec2,
  vSelf: Vec2,
  obj: SpaceObject,
  tNow: number,
  horizon: number,
): Approach {
  const mu = bodyById(obj.body).mu;
  const sep = (dt: number): number => {
    const a = propagateKepler(rSelf, vSelf, dt, mu);
    const b = objectStateAt(obj, tNow + dt);
    return norm(sub(a.r, b.r));
  };
  const N = 256;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const d = sep((i / N) * horizon);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  // Ternary refine within the bracketing samples.
  let lo = (Math.max(0, bestI - 1) / N) * horizon;
  let hi = (Math.min(N, bestI + 1) / N) * horizon;
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (sep(m1) <= sep(m2)) hi = m2;
    else lo = m1;
  }
  const dt = (lo + hi) / 2;
  const a = propagateKepler(rSelf, vSelf, dt, mu);
  const b = objectStateAt(obj, tNow + dt);
  return { dt, dist: norm(sub(a.r, b.r)), relSpeed: norm(sub(a.v, b.v)) };
}
