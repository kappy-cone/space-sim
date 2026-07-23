// Ascent autopilot: a classic gravity-turn pitch program plus an
// apoapsis-centered circularization burn. This is both the default flight
// controller in the game and the pilot for the headless reference-ascent
// test — the player can override any of it manually in flight.
// All orbital math is relative to the sim's reference body.

import { SPOOL_TAU, Sim } from './sim';
import { norm } from './vec2';
import { CelestialBody, EARTH } from './bodies';
import { stageDryMass, stageEffectiveVe, stageMassFlow, stagePropellant, stageThrustVac } from './vehicle';

export type AutopilotPhase = 'ascent' | 'coast' | 'circularize' | 'done' | 'failed';

export interface AscentPlan {
  /** Target circular orbit radius [m] (from the body's center). */
  targetRadius: number;
  /** Airspeed [m/s] below which the rocket flies straight up. */
  verticalUntil: number;
  /** Pitch program reference speed [m/s]: pitch from vertical is
   * 90°·(airspeed/ref)^pitchExponent — horizontal at orbital-class speed. */
  pitchRefSpeed: number;
  /** Shape of the turn: 0.5 = lofted, lower = flatter earlier. */
  pitchExponent: number;
}

export const defaultPlan = (targetAltitude: number, body: CelestialBody = EARTH): AscentPlan => ({
  targetRadius: body.radius + targetAltitude,
  verticalUntil: 30,
  pitchRefSpeed: 7_800,
  pitchExponent: 0.4,
});

export class Autopilot {
  phase: AutopilotPhase = 'ascent';
  constructor(readonly plan: AscentPlan) {}

  /** Δv to circularize at the current apoapsis (vis-viva at apo). */
  private circularizationDv(sim: Sim): number {
    const el = sim.elements;
    if (!(el.rApo < Infinity)) return 0;
    const mu = sim.body.mu;
    const vApo = Math.sqrt(Math.max(0, mu * (2 / el.rApo - 1 / el.a)));
    const vCirc = Math.sqrt(mu / el.rApo);
    return vCirc - vApo;
  }

  /** Estimated duration of a Δv burn, walking through remaining stages
   * (rocket equation per stage: t = m(1 − e^(−Δv/vₑ))/ṁ). The upper stage
   * usually dominates — estimating with only the current (nearly-empty
   * first) stage badly under-times the burn. */
  private burnTime(sim: Sim, dv: number): number {
    let t = 0;
    let m = sim.state.m;
    let remaining = dv;
    for (let i = sim.stageIndex; i < sim.vehicle.stages.length && remaining > 0; i++) {
      const stage = sim.vehicle.stages[i]!;
      const prop = i === sim.stageIndex ? sim.propellant : stagePropellant(stage);
      const ve = stageEffectiveVe(stage);
      const mdot = stageMassFlow(stage);
      if (mdot === 0 || ve === 0) continue;
      const dvStage = ve * Math.log(m / (m - prop));
      if (dvStage >= remaining) {
        t += (m * (1 - Math.exp(-remaining / ve))) / mdot;
        remaining = 0;
      } else {
        t += prop / mdot;
        remaining -= dvStage;
        m -= prop + stageDryMass(stage); // stage burns out and is dropped
      }
    }
    return t;
  }

  /** Drive the sim for this control tick: sets attitude/throttle/staging. */
  update(sim: Sim): void {
    if (sim.crashed) {
      this.phase = 'failed';
      return;
    }
    // Auto-stage: current stage dry and another remains.
    if (sim.propellant === 0 && sim.stageIndex < sim.vehicle.stages.length - 1) {
      sim.stage();
    }
    const el = sim.elements;

    switch (this.phase) {
      case 'ascent': {
        const airspeed = norm(sim.airspeedVec);
        if (airspeed < this.plan.verticalUntil) {
          sim.attitude = { mode: 'vertical' };
        } else {
          const pitch =
            (Math.PI / 2) *
            Math.min(1, Math.pow(airspeed / this.plan.pitchRefSpeed, this.plan.pitchExponent));
          sim.attitude = { mode: 'pitch', angle: pitch };
        }
        sim.throttle = 1;
        if (el.rApo >= this.plan.targetRadius) {
          sim.throttle = 0;
          this.phase = 'coast';
        }
        break;
      }
      case 'coast': {
        sim.throttle = 0;
        sim.attitude = { mode: 'prograde' };
        // Ignite so the burn straddles apoapsis: start at half the burn time.
        const tBurn = this.burnTime(sim, this.circularizationDv(sim));
        if (el.timeToApo <= tBurn / 2 || el.timeToApo > el.period / 2 + tBurn) {
          this.phase = 'circularize';
        }
        break;
      }
      case 'circularize': {
        // Prograde burn with an ENERGY cutoff. Prograde thrust keeps the
        // steering loss near zero (any off-velocity component of a long
        // insertion burn shows up 1:1 as steering loss); cutting off when
        // the semi-major axis reaches the target radius leaves an orbit
        // *centered* on the target — the old periapsis-threshold cutoff
        // kept adding energy until Pe caught up, overshooting Ap by
        // hundreds of km whenever the stage had Δv margin.
        sim.attitude = { mode: 'prograde' };
        // Δv equivalent of the remaining energy shortfall, for the taper:
        // dE = μ·da/(2a²), and prograde thrust adds energy at rate v·(T/m),
        // so dv_remaining ≈ μ·(r_t − a)/(2a²·v).
        const TAPER = 2.5; // s; spool τ = 0.4 s tracks this comfortably
        const minPeri = sim.body.radius + (sim.body.atmosphere?.topAltitude ?? 0) + 20_000;
        const speed = norm(sim.state.v);
        const dvE =
          el.a > 0 && el.a < this.plan.targetRadius
            ? (sim.body.mu * (this.plan.targetRadius - el.a)) / (2 * el.a * el.a * speed)
            : 0;
        // Pe shortfall in Δv terms: a tangential burn moves the opposite
        // apsis by Δr ≈ 4a·Δv/v (first-order from the vis-viva relation).
        const dvP = el.a > 0 ? (Math.max(0, minPeri - el.rPeri) * speed) / (4 * el.a) : 0;
        const stage = sim.vehicle.stages[sim.stageIndex];
        const aMax = stage ? stageThrustVac(stage) / sim.state.m : 0;
        sim.throttle = aMax > 0 ? Math.min(1, Math.max(0.05, (dvE + dvP) / (aMax * TAPER))) : 1;
        // Cutoff on energy (a at target) — but never with the periapsis
        // still in the atmosphere: a flat ascent can reach the target
        // energy while Pe is low, and that orbit decays. The plain Pe
        // threshold stays as a safety net for degenerate states.
        // Shutdown is not instantaneous: the spool-down tail integrates
        // to ~throttle·aMax·τ of extra Δv (min-throttle floors make this
        // several m/s), which raises a by 2a²v·Δv/μ — anticipate it.
        const dvTail = sim.actualThrottle * aMax * SPOOL_TAU;
        const daTail = el.a > 0 ? (2 * el.a * el.a * speed * dvTail) / sim.body.mu : 0;
        if (
          (el.a > 0 && el.a + daTail >= this.plan.targetRadius && el.rPeri >= minPeri) ||
          el.rPeri >= this.plan.targetRadius - 2_000
        ) {
          sim.throttle = 0;
          this.phase = 'done';
        } else if (sim.propellant === 0 && sim.stageIndex >= sim.vehicle.stages.length - 1) {
          sim.throttle = 0;
          this.phase = 'failed'; // ran dry — orbit not achieved
        }
        break;
      }
      case 'done':
      case 'failed':
        break;
    }
  }
}
