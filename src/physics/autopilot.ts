// Ascent autopilot: a classic gravity-turn pitch program plus an
// apoapsis-centered circularization burn. This is both the default flight
// controller in the game and the pilot for the headless reference-ascent
// test — the player can override any of it manually in flight.
// All orbital math is relative to the sim's reference body.

import { Sim } from './sim';
import { norm } from './vec2';
import { CelestialBody, EARTH } from './bodies';
import { stageDryMass, stageEffectiveVe, stageMassFlow, stagePropellant } from './vehicle';

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
        sim.attitude = { mode: 'prograde' };
        sim.throttle = 1;
        // Done when periapsis reaches the target (small tolerance below).
        if (el.rPeri >= this.plan.targetRadius - 20_000) {
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
