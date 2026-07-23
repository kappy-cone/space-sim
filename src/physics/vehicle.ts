// Vehicle model: stages built from parts, aggregated to point-mass
// properties, plus the pre-flight numbers the builder shows live
// (per-stage Δv, TWR at ignition and burnout).

import { G0, MU_EARTH, R_EARTH, P0_SEA_LEVEL } from './constants';

export interface Engine {
  id: string;
  name: string;
  thrustSL: number; // sea-level thrust [N] (0 for vacuum-only engines)
  thrustVac: number; // vacuum thrust [N]
  ispSL: number; // sea-level specific impulse [s] (0 for vacuum-only)
  ispVac: number; // vacuum specific impulse [s]
  mass: number; // engine dry mass [kg]
  vacuumOnly: boolean; // nozzle can't run at sea level (flow separation)
  /** Deepest stable throttle setting [fraction of rated]. 1 = fixed
   * thrust (no in-flight throttling). Commands below this run AT this —
   * an engine cannot run below its floor. */
  minThrottle: number;
  /** Total ignitions available (first light included); Infinity for
   * spark-ignition engines designed for unlimited restarts. */
  ignitions: number;
}

export interface Tank {
  id: string;
  name: string;
  propellantMass: number; // usable propellant [kg]
  dryMass: number; // structure [kg]
}

/** N identical engines burning together. A stage may mix groups
 * (e.g. core engine + radial boosters' engines). */
export interface EngineGroup {
  engine: Engine;
  count: number;
}

export interface Stage {
  engines: EngineGroup[];
  tanks: Tank[];
  /** Dry mass beyond engines and tank structure (decouplers, fairings,
   * radial mounts…) jettisoned with this stage. */
  extraDryMass?: number;
}

export interface Vehicle {
  /** stages[0] burns first (bottom of the stack). */
  stages: Stage[];
  payloadMass: number; // [kg]
  /** Aggregate drag coefficient. ~0.5 is a typical average for a slender
   * launch vehicle across the ascent Mach range (transonic peak ~0.6+,
   * supersonic ~0.3); the vehicle is a point mass so one number covers it. */
  cd: number;
  /** Frontal reference area [m²]. */
  area: number;
  /** Part layout along the axis for CoM/inertia/CoP; synthesized from the
   * stage list when absent (hand-rolled vehicles, tests). */
  geometry?: import('./massmodel').VehicleGeometry;
  /** Reaction-control torque authority [N·m] (cold-gas RCS class, from the
   * payload pod). ~1.6 kN·m for a crewed-capsule Draco-class couple. */
  rcsTorque?: number;
}

/**
 * Propellant mass flow [kg/s] at full throttle, per engine.
 * ṁ = F_vac / (g₀ · Isp_vac) — g₀ by the definition of specific impulse
 * (NOT local gravity). ṁ is constant; thrust and Isp vary with ambient
 * pressure at fixed ṁ.
 */
export function massFlow(e: Engine): number {
  return e.thrustVac / (G0 * e.ispVac);
}

/**
 * Thrust [N] per engine at ambient pressure p [Pa].
 * F(p) = F_vac − (F_vac − F_SL)·(p/p₀): thrust is F_vac minus p·A_exit
 * (nozzle exit area × ambient pressure), hence exactly linear in p.
 * For vacuum-only engines we still extrapolate linearly from the published
 * vacuum point using an estimated exit area — the sim never fires them in
 * thick atmosphere anyway (the builder warns instead).
 */
export function thrustAtPressure(e: Engine, p: number): number {
  if (e.vacuumOnly) {
    // Without a published sea-level point, approximate p·A_exit falloff as
    // proportional to F_vac (large vacuum nozzles lose thrust fast); clamp ≥ 0.
    return Math.max(0, e.thrustVac * (1 - (2 * p) / P0_SEA_LEVEL));
  }
  return e.thrustVac - (e.thrustVac - e.thrustSL) * (p / P0_SEA_LEVEL);
}

/** Isp [s] at ambient pressure p — thrust over the constant mass flow. */
export function ispAtPressure(e: Engine, p: number): number {
  return thrustAtPressure(e, p) / (massFlow(e) * G0);
}

// ---------- stage aggregates ----------

export function stageMassFlow(s: Stage): number {
  return s.engines.reduce((sum, g) => sum + massFlow(g.engine) * g.count, 0);
}

export function stageThrustVac(s: Stage): number {
  return s.engines.reduce((sum, g) => sum + g.engine.thrustVac * g.count, 0);
}

export function stageThrustAtPressure(s: Stage, p: number): number {
  return s.engines.reduce((sum, g) => sum + thrustAtPressure(g.engine, p) * g.count, 0);
}

export function stagePropellant(s: Stage): number {
  return s.tanks.reduce((sum, t) => sum + t.propellantMass, 0);
}

export function stageDryMass(s: Stage): number {
  return (
    (s.extraDryMass ?? 0) +
    s.engines.reduce((sum, g) => sum + g.engine.mass * g.count, 0) +
    s.tanks.reduce((sum, t) => sum + t.dryMass, 0)
  );
}

export function stageWetMass(s: Stage): number {
  return stageDryMass(s) + stagePropellant(s);
}

/** Total vehicle mass with stages i..end attached and all propellant loaded. */
export function massFromStage(v: Vehicle, i: number): number {
  let m = v.payloadMass;
  for (let k = i; k < v.stages.length; k++) m += stageWetMass(v.stages[k]!);
  return m;
}

/** Deepest throttle the stage can hold: all engines burn together, so a
 * mixed stage floors at its highest per-engine floor. */
export function stageMinThrottle(s: Stage): number {
  return s.engines.reduce((m, g) => Math.max(m, g.engine.minThrottle), 0);
}

/** Ignitions available to the stage as a unit (engines light together, so
 * the scarcest igniter budget governs). */
export function stageIgnitionLimit(s: Stage): number {
  return s.engines.reduce((m, g) => Math.min(m, g.engine.ignitions), Infinity);
}

/** Effective vacuum exhaust velocity [m/s] of a mixed-engine stage:
 * vₑ = ΣF_vac / Σṁ (thrust-weighted; exact for constant ṁ engines). */
export function stageEffectiveVe(s: Stage): number {
  const mdot = stageMassFlow(s);
  return mdot > 0 ? stageThrustVac(s) / mdot : 0;
}

export interface StageReport {
  /** Vacuum Δv [m/s] — Tsiolkovsky with g₀-based ṁ and vacuum thrust. */
  deltaV: number;
  /** Sea-level Δv [m/s] — same masses, sea-level thrust (lower bound). */
  deltaVSeaLevel: number;
  /** Thrust-to-weight at ignition, weight = m·g at the surface (μ/R²).
   * First stage uses sea-level thrust, upper stages vacuum thrust. */
  twrIgnition: number;
  /** Thrust-to-weight at burnout (propellant empty, stage still attached). */
  twrBurnout: number;
  ignitionMass: number; // [kg]
  burnoutMass: number; // [kg]
  burnTime: number; // [s] at full throttle
  propellantMass: number; // [kg]
}

export const SURFACE_G = MU_EARTH / (R_EARTH * R_EARTH); // ~9.798 m/s² — local g for TWR display

export function stageReport(v: Vehicle, i: number): StageReport {
  const stage = v.stages[i]!;
  const m0 = massFromStage(v, i);
  const m1 = m0 - stagePropellant(stage);
  // First stage breathes sea-level air; upper stages effectively vacuum.
  const thrust = i === 0 ? stageThrustAtPressure(stage, P0_SEA_LEVEL) : stageThrustVac(stage);
  const mdot = stageMassFlow(stage);
  const veVac = stageEffectiveVe(stage);
  const veSL = mdot > 0 ? stageThrustAtPressure(stage, P0_SEA_LEVEL) / mdot : 0;
  return {
    // Tsiolkovsky: Δv = vₑ · ln(m₀/m₁), vₑ = g₀·Isp_eff (g₀ from the
    // definition of Isp — not local gravity).
    deltaV: veVac * Math.log(m0 / m1),
    deltaVSeaLevel: veSL * Math.log(m0 / m1),
    twrIgnition: thrust / (m0 * SURFACE_G),
    twrBurnout: thrust / (m1 * SURFACE_G),
    ignitionMass: m0,
    burnoutMass: m1,
    burnTime: mdot > 0 ? stagePropellant(stage) / mdot : Infinity,
    propellantMass: stagePropellant(stage),
  };
}

export function totalDeltaV(v: Vehicle): number {
  return v.stages.reduce((sum, _s, i) => sum + stageReport(v, i).deltaV, 0);
}
