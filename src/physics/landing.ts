// Landing autopilot: executes exactly the burn the suicide-burn predictor
// recommends — retrograde, full throttle when the radar altitude reaches
// the predicted burn altitude, then throttle-modulated final descent.
// This is both the auto-land control in the game and the predictor's
// self-test: if predictor and integrator disagree, the touchdown fails.

import { Sim } from './sim';
import { stageThrustAtPressure } from './vehicle';
import { cross, norm, scale } from './vec2';

export type LandingPhase = 'fall' | 'burn' | 'final' | 'done' | 'failed';

const FINAL_DESCENT_SPEED = 2; // m/s target at touchdown
const LEG_DEPLOY_ALT = 2_000; // m radar altitude

export class LandingAutopilot {
  phase: LandingPhase = 'fall';

  update(sim: Sim): void {
    if (sim.crashed) {
      this.phase = 'failed';
      return;
    }
    if (sim.landed && sim.hasLanded) {
      sim.throttle = 0;
      this.phase = 'done';
      return;
    }
    const radar = sim.radarAltitude;
    if (radar < LEG_DEPLOY_ALT) sim.deployLegs();
    if (sim.vSpeed > 15) {
      // Fast descent: point against the total surface-relative velocity —
      // the burn kills vertical and horizontal components together.
      sim.attitude = { mode: 'surfaceRetrograde' };
    } else {
      // Terminal descent: near-vertical, tilted against the remaining
      // horizontal drift. Want a_h = −k·v_h with thrust ≈ m·g, so
      // tilt = asin(k·v_h/g), capped at ±0.2 rad. A translated descent
      // otherwise carries its drift into the h-speed touchdown limit.
      const up = scale(sim.state.r, 1 / norm(sim.state.r));
      const vh = cross(up, sim.airspeedVec); // signed, + along the perp (east) direction
      const rn = norm(sim.state.r);
      const g = sim.body.mu / (rn * rn);
      const tilt = Math.max(-0.2, Math.min(0.2, Math.asin(Math.max(-1, Math.min(1, (-0.7 * vh) / g)))));
      // The pitch attitude mode multiplies by sign(h); pre-multiply so the
      // sign cancels and the tilt lands in the intended direction.
      const signH = Math.sign(cross(sim.state.r, sim.state.v)) || 1;
      sim.attitude = { mode: 'pitch', angle: tilt * signH };
    }

    switch (this.phase) {
      case 'fall': {
        sim.throttle = 0;
        const hBurn = sim.suicideBurnAltitude;
        // 5% margin: burning a touch early costs little; late is fatal.
        if (isFinite(hBurn) && radar <= hBurn * 1.05) this.phase = 'burn';
        break;
      }
      case 'burn': {
        sim.throttle = 1;
        if (sim.vSpeed < FINAL_DESCENT_SPEED * 3) this.phase = 'final';
        break;
      }
      case 'final': {
        // Hold a gentle constant descent: thrust ≈ m·(g + k·(v − v_target)).
        const rn = Math.hypot(sim.state.r.x, sim.state.r.y);
        const g = sim.body.mu / (rn * rn);
        const stage = sim.vehicle.stages[sim.stageIndex];
        if (!stage) break;
        const p = sim.body.atmosphere?.pressure(Math.max(0, sim.altitude)) ?? 0;
        const tMax = stageThrustAtPressure(stage, p) || 1;
        const want = sim.state.m * (g + 1.2 * (sim.vSpeed - FINAL_DESCENT_SPEED));
        sim.throttle = Math.min(1, Math.max(0, want / tMax));
        break;
      }
      case 'done':
      case 'failed':
        break;
    }
  }
}
