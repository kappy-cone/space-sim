// Finite-wing aerodynamics for the plane vehicle class: lift slope with
// aspect-ratio correction, stall with a flat-plate post-stall blend, and
// induced drag. Pure functions — the sim applies them per lifting surface
// inside the RK4 derivative; rockets never call into this file.
//
// Sources are cited per constant/formula. Planar 3-DOF: a "wing" here is
// the whole wing PAIR (span = full tip-to-tip), so S and AR are the
// full-planform values and no spanwise effects exist beyond the induced
// terms.

/** Thin-airfoil lift-curve slope a₀ = 2π per radian
 * (Anderson, Fundamentals of Aerodynamics, 6th ed., §4.8). */
export const A0 = 2 * Math.PI;

/** Flat-plate normal-force coefficient at 90° incidence, C_N ≈ 1.98
 * (Hoerner, Fluid-Dynamic Drag, ch. 3 — flat plate normal to stream). */
export const FLAT_PLATE_CN = 1.98;

/** Post-stall blend band [rad]: attached flow fades into the flat-plate
 * model over ~5° past the stall angle. ESTIMATE — real stall sharpness
 * varies by airfoil; 5° gives a continuous, deterministic curve without
 * modeling separation dynamics. */
export const STALL_BLEND = (5 * Math.PI) / 180;

/** Elevator throw limit [rad]: ±25°, typical transport-category elevator
 * deflection range (ESTIMATE — class value, e.g. 737 elevator ≈ ±26°). */
export const ELEV_MAX = (25 * Math.PI) / 180;

/**
 * Finite-wing lift-curve slope [1/rad].
 * High AR: a = a₀ / (1 + a₀/(π·e·AR)) — Prandtl lifting-line correction
 * (Anderson §5.4, eq. 5.70). Low AR (< 4, deltas): Helmbold's equation
 * a = a₀ / (√(1 + (a₀/(π·e·AR))²) + a₀/(π·e·AR)) (Anderson eq. 5.82 —
 * lifting-surface correction that stays accurate for small AR).
 */
export function liftSlope(ar: number, e: number): number {
  const k = A0 / (Math.PI * e * ar);
  if (ar < 4) return A0 / (Math.sqrt(1 + k * k) + k);
  return A0 / (1 + k);
}

/** Stall angle [rad] from the linear model: α_stall = Cl_max / a. */
export function stallAngle(clMax: number, slope: number): number {
  return clMax / slope;
}

/**
 * Section force coefficients for one surface at local angle of attack
 * α [rad] (chord-relative, incidence and control deflection already
 * added by the caller). Returns signed Cl and total Cd.
 *
 * Attached (|α| < α_stall): Cl = a·α, Cd = cd0 + Cl²/(π·e·AR)
 * (induced drag: Anderson §5.3, eq. 5.61).
 * Post-stall (|α| > α_stall + blend): flat plate, C_N = 1.98·sin α;
 * Cl = C_N·cos α, Cd = cd0 + C_N·sin α (Hoerner ch. 3; the standard
 * flat-plate decomposition used by post-stall extrapolations à la
 * Viterna). Between: linear blend of the two models — continuous
 * everywhere, no separation state.
 */
export function surfaceCoefficients(
  alpha: number,
  slope: number,
  ar: number,
  e: number,
  clMax: number,
  cd0: number,
): { cl: number; cd: number } {
  const aStall = stallAngle(clMax, slope);
  const mag = Math.abs(alpha);
  const attached = (): { cl: number; cd: number } => {
    const cl = slope * alpha;
    return { cl, cd: cd0 + (cl * cl) / (Math.PI * e * ar) };
  };
  const plate = (): { cl: number; cd: number } => {
    const cn = FLAT_PLATE_CN * Math.sin(alpha);
    return { cl: cn * Math.cos(alpha), cd: cd0 + Math.abs(cn * Math.sin(alpha)) };
  };
  if (mag <= aStall) return attached();
  if (mag >= aStall + STALL_BLEND) return plate();
  const w = (mag - aStall) / STALL_BLEND;
  const a = attached();
  const p = plate();
  return { cl: a.cl * (1 - w) + p.cl * w, cd: a.cd * (1 - w) + p.cd * w };
}

/**
 * Plain-flap control effectiveness τ = 1 − (θ_f − sin θ_f)/π with
 * θ_f = acos(2·cf/c − 1), from thin-airfoil flap theory (Glauert;
 * Anderson §4.9). Overpredicts real hinged surfaces by ~15%
 * (Nelson, Flight Stability and Automatic Control, fig. 2.21) —
 * accepted as the sourced ideal rather than an invented fudge.
 */
export function flapEffectiveness(controlFraction: number): number {
  const cf = Math.min(1, Math.max(0, controlFraction));
  const theta = Math.acos(2 * cf - 1);
  return 1 - (theta - Math.sin(theta)) / Math.PI;
}

/** Downwash derivative at the tail, dε/dα ≈ 2·a_wing/(π·AR_wing)
 * (Nelson, 2nd ed., eq. 2.23). The tail's effective slope is
 * a_t·(1 − dε/dα). */
export function downwashDerivative(wingSlope: number, wingAr: number): number {
  return (2 * wingSlope) / (Math.PI * wingAr);
}

/** Mean aerodynamic chord of a trapezoidal planform
 * (standard result, e.g. Raymer, Aircraft Design, 6th ed., §4.2):
 * MAC = (2/3)·(cr + ct − cr·ct/(cr + ct)). */
export function meanAeroChord(cr: number, ct: number): number {
  return (2 / 3) * (cr + ct - (cr * ct) / (cr + ct || 1e-9));
}
