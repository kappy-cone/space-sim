// Atmospheric decay for registry objects — the world's garbage collector.
//
// Method: orbit-averaged drag in the plane, kept exactly two-body between
// updates. Over one revolution the drag acceleration a_d = ½ρv²·(CdA/m)
// (antiparallel to v) changes the specific energy and the specific
// angular momentum by
//     ΔE  = −∮ (CdA/2m)·ρ·v³ dt          (drag power per unit mass)
//     Δh  = −∮ (CdA/2m)·ρ·v·h dt         (from dh/dt = r×a_d = −(CdA/2m)·ρ·v·h)
// evaluated by trapezoid quadrature in eccentric anomaly with the sim's
// own density model (Vallado Table 8-4 exponential fit, defined to
// 1000 km — see physics/atmosphere.ts). New (a, e) follow from
// E = −μ/2a and e² = 1 + 2Eh²/μ². This is the standard averaged
// variation-of-parameters treatment of drag (Vallado, "Fundamentals of
// Astrodynamics and Applications" 4th ed. §9.6; King-Hele, "Theory of
// Satellite Orbits in an Atmosphere", 1964). For a circular orbit it
// reduces to the classical per-revolution decay Δa = −2π·(CdA/m)·ρ·a²,
// which the test suite pins.
//
// Dropped (and why): solar-activity density variation (USSA76 is a
// static mean atmosphere — real decay times vary ×3–5 over the solar
// cycle), attitude-dependent drag area (objects are treated as tumbling
// with a fixed mean CdA), and rotation of the atmosphere (≤ ~7% effect
// on the drag magnitude at LEO speeds).

import { density } from '../physics/atmosphere';

/** Perigee altitude below which an object is treated as reentered [m].
 * Below ~90 km a full revolution cannot be completed — drag rises three
 * orders of magnitude over one scale height (class value; the entry
 * interface convention is 120 km, demise well below). */
export const REENTRY_FLOOR = 90_000;

/** Perigee altitude above which decay is skipped entirely [m]: the
 * density table ends at 1000 km, where the e-folding time is measured
 * in centuries — negligible against any campaign. */
export const DECAY_CEILING = 1_000_000;

const QUAD_POINTS = 64;

export interface MeanOrbit {
  /** Semi-major axis [m]. */
  a: number;
  /** Eccentricity. */
  e: number;
}

/**
 * Per-revolution drag integrals for a unit ballistic term (CdA/m = 1):
 * energy loss dE [J/kg], angular-momentum loss dh [m²/s], and the drag
 * Δv [m/s] (∮ a_d dt — what station-keeping must buy back). Multiply
 * each by the object's CdA/m.
 */
export function perOrbitDrag(
  a: number,
  e: number,
  mu: number,
  bodyRadius: number,
): { dE: number; dh: number; dv: number } {
  const n = Math.sqrt(mu / (a * a * a)); // mean motion
  const h = Math.sqrt(mu * a * (1 - e * e));
  let dE = 0;
  let dh = 0;
  let dv = 0;
  // Trapezoid in eccentric anomaly over one revolution:
  // r = a(1 − e·cosE), v² = μ(2/r − 1/a), dt = (1 − e·cosE)/n dE.
  const dEa = (2 * Math.PI) / QUAD_POINTS;
  for (let i = 0; i < QUAD_POINTS; i++) {
    const E = -Math.PI + (i + 0.5) * dEa; // midpoint rule (periodic integrand)
    const r = a * (1 - e * Math.cos(E));
    const alt = r - bodyRadius;
    if (alt > DECAY_CEILING) continue;
    const rho = density(alt); // defined (and cited) up to 1000 km
    const v2 = mu * (2 / r - 1 / a);
    const v = Math.sqrt(v2);
    const dt = ((1 - e * Math.cos(E)) / n) * dEa;
    dE += 0.5 * rho * v2 * v * dt; // ½ρv³ per unit CdA/m
    dh += 0.5 * rho * v * h * dt;
    dv += 0.5 * rho * v2 * dt; // ½ρv² — the deceleration itself
  }
  return { dE: -dE, dh: -dh, dv };
}

export interface DecayResult {
  a: number;
  e: number;
  /** Seconds of the requested interval actually consumed (equals the
   * request unless the object reentered first). */
  tUsed: number;
  reentered: boolean;
  /** Total drag Δv over the interval [m/s] — what station-keeping would
   * have had to buy back. */
  dvDrag: number;
}

/**
 * Advance a mean orbit through dtTotal seconds of drag. Chunked in whole
 * revolutions with the per-chunk energy change capped at 2% so the
 * averaging stays honest through the accelerating final decay.
 */
export function advanceDecay(
  orbit: MeanOrbit,
  cdAOverM: number,
  dtTotal: number,
  mu: number,
  bodyRadius: number,
): DecayResult {
  let { a, e } = orbit;
  let t = 0;
  let dvDrag = 0;
  for (let guard = 0; guard < 20_000 && t < dtTotal; guard++) {
    const rPeri = a * (1 - e);
    if (rPeri - bodyRadius < REENTRY_FLOOR || a <= bodyRadius) {
      return { a, e, tUsed: t, reentered: true, dvDrag };
    }
    if (rPeri - bodyRadius > DECAY_CEILING) break; // out of the drag regime
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    const per = perOrbitDrag(a, e, mu, bodyRadius);
    const dEOrbit = per.dE * cdAOverM;
    if (dEOrbit === 0) break; // whole orbit above the table
    const energy = -mu / (2 * a);
    // Revolutions per chunk: |ΔE| ≤ 2% of |E|, at least one, and never
    // more than the remaining interval.
    const kEnergy = Math.max(1, Math.floor((0.02 * Math.abs(energy)) / Math.abs(dEOrbit)));
    const kTime = Math.max(1, Math.floor((dtTotal - t) / T));
    const k = Math.min(kEnergy, kTime);
    const h0 = Math.sqrt(mu * a * (1 - e * e));
    const E1 = energy + dEOrbit * k;
    const h1 = h0 + per.dh * cdAOverM * k;
    if (E1 >= 0) {
      // Numerical overshoot past escape can only mean the orbit collapsed
      // within the chunk — treat as reentry.
      return { a, e, tUsed: t + k * T, reentered: true, dvDrag };
    }
    a = -mu / (2 * E1);
    const e2 = 1 + (2 * E1 * h1 * h1) / (mu * mu);
    e = e2 > 1e-12 ? Math.sqrt(e2) : 0;
    dvDrag += per.dv * cdAOverM * k;
    t += k * T;
    if (kTime === k && kEnergy > kTime) break; // interval exhausted mid-orbit: close enough (< 1 rev)
  }
  return { a, e, tUsed: Math.min(t, dtTotal), reentered: false, dvDrag };
}
