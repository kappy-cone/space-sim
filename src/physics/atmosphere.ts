// Atmospheric density and pressure.
//
// DENSITY: piecewise-exponential fit to the US Standard Atmosphere 1976
// (and CIRA-72 above 86 km), as tabulated in Vallado, "Fundamentals of
// Astrodynamics and Applications", 4th ed., Table 8-4 ("Exponential
// Atmospheric Model"). Within each altitude band:
//     ρ(h) = ρ₀ · exp(−(h − h₀)/H)
// with base altitude h₀, base density ρ₀ and scale height H per band.
//
// PRESSURE: US Standard Atmosphere 1976 barometric layers (0–86 km
// geopotential), used for the thrust/Isp ambient-pressure correction.
// Above 86 km ambient pressure is < 4e-6 of sea level — engines see vacuum.

import { P0_SEA_LEVEL } from './constants';

// [base altitude h₀ (m), base density ρ₀ (kg/m³), scale height H (m)]
// Vallado 4th ed. Table 8-4, converted km → m.
const DENSITY_TABLE: readonly [number, number, number][] = [
  [0, 1.225, 7_249],
  [25_000, 3.899e-2, 6_349],
  [30_000, 1.774e-2, 6_682],
  [40_000, 3.972e-3, 7_554],
  [50_000, 1.057e-3, 8_382],
  [60_000, 3.206e-4, 7_714],
  [70_000, 8.77e-5, 6_549],
  [80_000, 1.905e-5, 5_799],
  [90_000, 3.396e-6, 5_382],
  [100_000, 5.297e-7, 5_877],
  [110_000, 9.661e-8, 7_263],
  [120_000, 2.438e-8, 9_473],
  [130_000, 8.484e-9, 12_636],
  [140_000, 3.845e-9, 16_149],
  [150_000, 2.07e-9, 22_523],
  [180_000, 5.464e-10, 29_740],
  [200_000, 2.789e-10, 37_105],
  [250_000, 7.248e-11, 45_546],
  [300_000, 2.418e-11, 53_628],
  [350_000, 9.518e-12, 53_298],
  [400_000, 3.725e-12, 58_515],
  [450_000, 1.585e-12, 60_828],
  [500_000, 6.967e-13, 63_822],
  [600_000, 1.454e-13, 71_835],
  [700_000, 3.614e-14, 88_667],
  [800_000, 1.17e-14, 124_640],
  [900_000, 5.245e-15, 181_050],
  [1_000_000, 3.019e-15, 268_000],
];

/** Atmospheric density [kg/m³] at altitude h [m] above the surface datum. */
export function density(h: number): number {
  if (h < 0) h = 0; // clamp: pad sits at the datum
  // Find the band whose base is at or below h (table is sorted ascending).
  let band = DENSITY_TABLE[0]!;
  for (const row of DENSITY_TABLE) {
    if (row[0] <= h) band = row;
    else break;
  }
  const [h0, rho0, H] = band;
  return rho0 * Math.exp(-(h - h0) / H);
}

// US Standard Atmosphere 1976 layer bases (geopotential altitude), Part 1,
// Table 4: [base altitude h_b (m'), lapse rate L (K/m'), base temperature
// T_b (K), base pressure p_b (Pa)]. Base pressures are the published values.
const PRESSURE_LAYERS: readonly [number, number, number, number][] = [
  [0, -0.0065, 288.15, 101_325],
  [11_000, 0, 216.65, 22_632.1],
  [20_000, 0.001, 216.65, 5_474.89],
  [32_000, 0.0028, 228.65, 868.019],
  [47_000, 0, 270.65, 110.906],
  [51_000, -0.0028, 270.65, 66.9389],
  [71_000, -0.002, 214.65, 3.95642],
];

// USSA76 constants: g₀' = 9.80665 m²/(s²·m'), R* = 8.31432 J/(mol·K),
// M₀ = 0.0289644 kg/mol → g₀'M₀/R* = 0.034163195 K/m'.
const GMR = (9.80665 * 0.0289644) / 8.31432;

// Geopotential altitude ceiling of the USSA76 barometric formulation
// (86 km geometric ≈ 84 852 m' geopotential).
const PRESSURE_MODEL_TOP = 84_852;

/**
 * Ambient pressure [Pa] at altitude h [m].
 * USSA76 barometric layers up to 86 km; ~0 above (engines see vacuum).
 * We use geometric altitude directly as geopotential — the difference is
 * <1.3% at 86 km and pressure there is already ~1e-5 of sea level.
 */
export function pressure(h: number): number {
  if (h < 0) h = 0;
  if (h > PRESSURE_MODEL_TOP) return 0;
  let layer = PRESSURE_LAYERS[0]!;
  for (const row of PRESSURE_LAYERS) {
    if (row[0] <= h) layer = row;
    else break;
  }
  const [hb, L, Tb, pb] = layer;
  if (L === 0) {
    // Isothermal layer: p = p_b · exp(−g₀M(h−h_b)/(R*T_b))
    return pb * Math.exp((-GMR * (h - hb)) / Tb);
  }
  // Gradient layer: p = p_b · (T_b/(T_b + L(h−h_b)))^(g₀M/(R*L))
  return pb * Math.pow(Tb / (Tb + L * (h - hb)), GMR / L);
}

/**
 * Ambient temperature [K] at altitude h [m] — USSA76 layer bases + linear
 * lapse rates (same table as the pressure model). Above the 86 km model
 * top the value is held at the last layer's profile; it only feeds the
 * speed of sound, which is irrelevant once drag has vanished.
 */
export function temperature(h: number): number {
  if (h < 0) h = 0;
  if (h > PRESSURE_MODEL_TOP) h = PRESSURE_MODEL_TOP;
  let layer = PRESSURE_LAYERS[0]!;
  for (const row of PRESSURE_LAYERS) {
    if (row[0] <= h) layer = row;
    else break;
  }
  const [hb, L, Tb] = layer;
  return Tb + L * (h - hb);
}

/**
 * Speed of sound [m/s]: a = √(γ·R_specific·T) with γ = 1.4 and
 * R = 287.053 J/(kg·K) for air (USSA76 constants).
 */
export function speedOfSound(h: number): number {
  return Math.sqrt(1.4 * 287.053 * temperature(h));
}

// Drag coefficient vs Mach: a fixed Cd is visibly wrong exactly at max-Q.
// Multiplier applied to the vehicle's subsonic Cd, shaped like published
// slender-launcher curves (e.g. Sutton, "Rocket Propulsion Elements",
// fig. drag data; NASA TN D-3283 class data): flat subsonic, sharp
// transonic rise peaking just past Mach 1, supersonic decay.
// [Mach, multiplier] breakpoints, linearly interpolated.
const CD_MACH_TABLE: readonly [number, number][] = [
  [0.0, 1.0],
  [0.8, 1.05],
  [1.05, 2.0], // transonic peak
  [1.3, 1.8],
  [2.0, 1.4],
  [3.0, 1.1],
  [5.0, 0.9],
  [8.0, 0.85],
];

/** Cd multiplier at a given Mach number (1.0 at low subsonic). */
export function machDragFactor(mach: number): number {
  const t = CD_MACH_TABLE;
  if (mach <= t[0]![0]) return t[0]![1];
  for (let i = 1; i < t.length; i++) {
    if (mach <= t[i]![0]) {
      const [m0, f0] = t[i - 1]!;
      const [m1, f1] = t[i]!;
      return f0 + ((f1 - f0) * (mach - m0)) / (m1 - m0);
    }
  }
  return t[t.length - 1]![1];
}

export { P0_SEA_LEVEL };
