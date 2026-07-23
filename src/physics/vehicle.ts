// Vehicle model: stages built from parts, aggregated to point-mass
// properties, plus the pre-flight numbers the builder shows live
// (per-stage Δv, TWR at ignition and burnout).

import { G0, MU_EARTH, R_EARTH, P0_SEA_LEVEL } from './constants';
import { PropellantId } from './propellants';

export interface Engine {
  id: string;
  name: string;
  /** Propellant the engine burns — REQUIRED on all propulsion. */
  propellant: PropellantId;
  thrustSL: number; // sea-level thrust [N] (0 for vacuum-only engines)
  thrustVac: number; // vacuum thrust [N]
  ispSL: number; // sea-level specific impulse [s] (0 for vacuum-only)
  ispVac: number; // vacuum specific impulse [s]
  mass: number; // engine dry mass [kg]
  vacuumOnly: boolean; // no published sea-level point (thrust extrapolated)
  /** Machine-checked citation — the validator rejects unsourced parts. */
  source: string;
  /** Must equal (minThrottle < 1); validated. Solids are never throttleable. */
  throttleable: boolean;
  /** Deepest stable throttle setting [fraction of rated]. 1 = fixed
   * thrust (no in-flight throttling). Commands below this run AT this —
   * an engine cannot run below its floor. */
  minThrottle: number;
  /** Total ignitions available (first light included); Infinity for
   * spark-ignition engines designed for unlimited restarts. Solids: 1. */
  ignitions: number;
  /** Thrust-vector gimbal range [± degrees]; 0 = fixed nozzle. */
  gimbalDeg: number;
  /** Nozzle expansion ratio (deployed, for extendable nozzles). */
  expansionRatio: number;
  /** Ambient pressure above which nozzle flow separates [Pa]. Firing
   * above it destroys the engine (side loads), not merely underperforms.
   * Derived per engine via the Summerfield criterion (separation when
   * p_exit < ~0.4·p_ambient) from published ε and chamber pressure;
   * Infinity for sea-level nozzles. */
  maxAmbientPressure: number;
  /** Immune to propellant settling requirements: pressure-fed engines
   * with propellant-management devices (surface-tension screens), and
   * solids. Pump-fed liquids need settled propellant to light. */
  ullageImmune: boolean;
  /** Solid grain thrust curve: [burn fraction 0..1, thrust multiplier of
   * rated]. Once lit a solid runs the curve to burnout — no throttle,
   * no shutdown, no restart. */
  thrustCurve?: [number, number][];
  /** Extendable nozzle (RL10B-2): stowed performance until deployed. */
  nozzleExtension?: { stowedExpansionRatio: number; stowedIspVac: number; stowedMaxAmbientPressure: number };
  /** Air-breathing engine: thrust = thrustSL·(ρ/ρ₀)·f(M) — first-order
   * density lapse with a per-engine Mach shape (Anderson, Aircraft
   * Performance and Design §3.5; Mattingly, Elements of Gas Turbine
   * Propulsion). Fuel-only mass flow ṁ = tsfc·T; no oxidizer aboard.
   * Set thrustVac = thrustSL and ispVac = ispSL = 1/(tsfc·g₀) so the
   * stage aggregates (Δv walk, ṁ) stay self-consistent at the
   * reference point. */
  airBreathing?: {
    /** f(M) breakpoints [[Mach, thrust multiplier]] — the CD_MACH_TABLE
     * pattern; linearly interpolated, clamped at the ends. */
    machTable: [number, number][];
    /** Below this Mach the engine cannot light or stay lit (ramjets
     * need a boost). 0 for turbomachinery. */
    minMach: number;
    /** Above this Mach: flameout (inlet unstart / temperature limit). */
    maxMach: number;
    /** Below this air density [kg/m³]: flameout (the service ceiling). */
    rhoFloor: number;
    /** Thrust-specific fuel consumption [kg/(N·s)]. */
    tsfc: number;
  };
}

/** Linear interpolation over an air-breather's f(M) table (clamped). */
export function machThrustFactor(table: [number, number][], mach: number): number {
  if (table.length === 0) return 1;
  if (mach <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    if (mach <= table[i]![0]) {
      const [m0, f0] = table[i - 1]!;
      const [m1, f1] = table[i]!;
      return f0 + ((f1 - f0) * (mach - m0)) / (m1 - m0 || 1e-9);
    }
  }
  return table[table.length - 1]![1];
}

export interface Tank {
  id: string;
  name: string;
  /** Fluid held — REQUIRED; density and boiloff follow from the registry. */
  fluid: PropellantId;
  /** Usable propellant volume [m³] — the primary quantity. Dry mass
   * scales with volume (35 kg/m³, see propellants.ts), NOT with
   * propellant mass, or the density tradeoff disappears. */
  volume: number;
  propellantMass: number; // usable propellant [kg] = volume × ρ_bulk
  dryMass: number; // structure [kg] = volume × 35
  source: string;
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

/** One propellant pool per compiled stage (that stage's sections' tanks
 * or solid grain). Crossfeed and parallel staging drain across pools. */
export interface PropellantPool {
  fluid: PropellantId;
  mass: number;
}

/** Engines lit during a phase, with the pool indices they drain in
 * priority order (crossfeed: an outboard pool before their own). */
export interface BurnGroup {
  engines: EngineGroup[];
  drain: number[];
  /** Compiled stage these engines belong to (failure bookkeeping). */
  stage: number;
}

/** Phase k = burn stage k. Its trigger pool is pool k: when that empties
 * the phase ends (stage separation drops those sections). Parallel
 * staging: a strap-on phase's groups include the sustainer's engines. */
export interface PhasePlan {
  groups: BurnGroup[];
}

/** One lifting surface (a full wing pair or tailplane — planar 3-DOF).
 * Precompiled from the wing part: geometry resolved to the numbers the
 * force model needs, so the deriv does no planform math. */
export interface LiftingSurface {
  /** Planform area [m²] (full pair). */
  S: number;
  /** Aspect ratio span²/S (full span). */
  AR: number;
  /** Finite-wing lift slope [1/rad] (aero.liftSlope). */
  a: number;
  /** Oswald efficiency (induced drag). */
  e: number;
  /** Fixed incidence [rad]: chord angle relative to the body axis. */
  incidence: number;
  /** Quarter-MAC height in stack coordinates [m] (force application). */
  y: number;
  clMax: number;
  cd0: number;
  /** Elevator effectiveness τ (aero.flapEffectiveness) — only on
   * control-surface-bearing tails; absent = fixed surface. */
  tau?: number;
  /** Tail-only: (1 − dε/dα) downwash factor on the α response. */
  downwash?: number;
}

/** Plane-class aero aggregate. ABSENT on every rocket — its presence is
 * the single gate for all plane physics, so rockets execute the exact
 * pre-plane instruction sequence (the golden fixtures pin this). */
export interface PlaneAero {
  surfaces: LiftingSurface[];
  /** Mean aerodynamic chord of the largest wing [m] (static margin unit). */
  mac: number;
  /** Elevator throw limit [rad]. ±25° — typical transport elevator
   * deflection range (ESTIMATE; class value). */
  elevMax: number;
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
  /** Propellant pools + burn phases (parallel staging / crossfeed).
   * Absent = serial: each stage drains its own tanks. */
  pools?: PropellantPool[];
  phases?: PhasePlan[];
  /** RCS translation thrust usable for ullage settling [N]. */
  rcsThrust?: number;
  /** Self-contained RCS propellant budget [kg]. */
  rcsPropellant?: number;
  /** CMG torque [N·m] and momentum capacity [N·m·s] before saturation. */
  wheelTorque?: number;
  wheelCapacity?: number;
  /** Active-fin control torque per unit dynamic pressure [N·m/Pa]. */
  finControlPerQ?: number;
  /** Per-stage drag state: cd and frontal area with fairings attached
   * and after fairing jettison, indexed by stageIndex. */
  drag?: { cdFaired: number[]; cdBare: number[]; areaFaired: number[]; areaBare: number[] };
  /** Dedicated solid ullage motors carried (count). */
  ullageMotors?: number;
  /** Dry mass jettisoned when phase k ends — the SECTION's own dry mass.
   * (stages[k].engines is the parallel-burn union, so summing engine
   * masses from it would double-count sustainer engines.) */
  sepMass?: number[];
  /** Stage k is a strap-on burning in parallel with the sustainer. */
  strapOn?: boolean[];
  /** Plane-class lifting surfaces + trim authority. Absent for rockets
   * (the gate for all plane physics). */
  planeAero?: PlaneAero;
  /** Landing-gear aggregate (plane class): whether it retracts (fixed
   * gear is always down), wheel brakes, deployed drag area Cd·A [m²],
   * and the gear-down q limit [Pa]. */
  gear?: { retractable: boolean; brakes: boolean; dragCdA: number; maxQ: number };
}

/** Thrust-curve multiplier for a solid at burn fraction x (0 = full
 * grain, 1 = burnout): linear interpolation over the published curve. */
export function thrustCurveAt(e: Engine, burnFraction: number): number {
  const c = e.thrustCurve;
  if (!c || c.length === 0) return 1;
  const x = Math.min(1, Math.max(0, burnFraction));
  for (let i = 1; i < c.length; i++) {
    if (x <= c[i]![0]) {
      const [t0, f0] = c[i - 1]!;
      const [t1, f1] = c[i]!;
      return f0 + ((f1 - f0) * (x - t0)) / (t1 - t0 || 1e-9);
    }
  }
  return c[c.length - 1]![1];
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
  if (v.sepMass && v.pools) {
    let m = v.payloadMass;
    for (let k = i; k < v.stages.length; k++) m += v.sepMass[k]! + v.pools[k]!.mass;
    return m;
  }
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

/** One phase of the closed-form drain walk (see phaseWalkReport). */
export interface PhaseWalkEntry {
  deltaV: number; // vacuum Δv over the phase [m/s]
  burnTime: number; // full-throttle time until the trigger pool empties [s]
  ignitionMass: number; // vehicle mass at phase start [kg]
  burnoutMass: number; // vehicle mass when the trigger pool empties [kg]
}

/**
 * Crossfeed/parallel-honest Δv: walk the phases draining pools exactly the
 * way the sim does (each burn group empties the first non-empty pool in its
 * drain-priority list — crossfed outboard pools before its own), in closed
 * form. Within a segment the group→pool assignment is fixed, so mass flow
 * and thrust-weighted vₑ are constant and Tsiolkovsky is exact; segments
 * end when a drained pool empties. Phase k ends when its trigger pool k
 * empties; separation drops sepMass[k]. Solid thrust curves scale thrust
 * and ṁ together, so vₑ — and hence Δv — is unaffected by the curve.
 * Returns null for serial vehicles without pool/phase plans (stageReport
 * is already exact there).
 */
export function phaseWalkReport(v: Vehicle): PhaseWalkEntry[] | null {
  if (!v.pools || !v.phases || !v.sepMass) return null;
  const pools = v.pools.map((p) => p.mass);
  let m = massFromStage(v, 0);
  const out: PhaseWalkEntry[] = [];
  for (let k = 0; k < v.stages.length; k++) {
    const phase = v.phases[k];
    const m0 = m;
    let dv = 0;
    let t = 0;
    while (phase && (pools[k] ?? 0) > 1e-9) {
      // The sim's pool selection: first non-empty pool in each drain list.
      const draining = phase.groups
        .map((g) => ({ g, pool: g.drain.find((d) => (pools[d] ?? 0) > 1e-9) ?? -1 }))
        .filter((x) => x.pool >= 0);
      if (draining.length === 0) break; // engineless phase: nothing can drain the trigger
      let thrust = 0;
      let mdotTotal = 0;
      const mdotByPool = new Map<number, number>();
      for (const { g, pool } of draining) {
        const grp = g.engines[0]!;
        const md = massFlow(grp.engine) * grp.count;
        thrust += grp.engine.thrustVac * grp.count;
        mdotTotal += md;
        mdotByPool.set(pool, (mdotByPool.get(pool) ?? 0) + md);
      }
      const ve = thrust / mdotTotal;
      let dt = Infinity;
      for (const [pool, md] of mdotByPool) dt = Math.min(dt, pools[pool]! / md);
      const burned = mdotTotal * dt;
      dv += ve * Math.log(m / (m - burned));
      m -= burned;
      t += dt;
      for (const [pool, md] of mdotByPool) pools[pool] = Math.max(0, pools[pool]! - md * dt);
    }
    out.push({ deltaV: dv, burnTime: t, ignitionMass: m0, burnoutMass: m });
    // Separation: the section's dry mass leaves, plus anything stranded in
    // its pool (an engineless phase's propellant rides down with it).
    m -= (v.sepMass[k] ?? 0) + (pools[k] ?? 0);
    pools[k] = 0;
  }
  return out;
}
