// Physical constants. Every value carries its published source.
// Values cross-checked against primary sources — see comments.

/**
 * Earth gravitational parameter GM⊕ [m³/s²].
 * Source: EGM96 / IERS Conventions 2010 (TN 36), GM⊕ = 3.986004418e14 m³/s²
 * (TCG-compatible value; the TT-compatible value differs only in the 10th digit).
 */
export const MU_EARTH = 3.986004418e14;

/**
 * Earth equatorial radius [m]. Surface and altitude datum for the sim
 * (we launch from the equator in the equatorial plane).
 * Source: WGS-84 defining parameter, semi-major axis a = 6 378 137.0 m.
 */
export const R_EARTH = 6_378_137;

/**
 * Earth rotation rate [rad/s].
 * Source: IERS Conventions 2010, nominal mean angular velocity
 * ω⊕ = 7.292115e-5 rad/s.
 */
export const OMEGA_EARTH = 7.292115e-5;

/**
 * Standard gravity g₀ [m/s²]. Exact by definition.
 * Source: 3rd CGPM (1901), gₙ = 9.80665 m/s².
 * NOTE: used ONLY to convert Isp [s] ↔ effective exhaust velocity / mass flow.
 * Local gravitational acceleration is always μ/r² — never this constant.
 */
export const G0 = 9.80665;

/**
 * Sea-level standard atmospheric pressure [Pa]. Exact by definition.
 * Source: ISA / US Standard Atmosphere 1976, p₀ = 101 325 Pa.
 */
export const P0_SEA_LEVEL = 101_325;

/**
 * Sea-level standard atmospheric density [kg/m³].
 * Source: US Standard Atmosphere 1976, ρ₀ = 1.225 kg/m³ at 15 °C, 101325 Pa.
 */
export const RHO0_SEA_LEVEL = 1.225;

/**
 * Altitude above which we treat the atmosphere as gone for *simulation
 * mode-switching* (drag negligible → safe to hand off to analytic Kepler).
 * 140 km: USSA76 density there is ~3.8e-9 kg/m³, giving sub-millinewton drag
 * on any plausible stage. (The density model itself extends to 1000 km and is
 * still used for readouts; this is only the coast handoff threshold.)
 */
export const ATMOSPHERE_COAST_HANDOFF_ALT = 140_000;
