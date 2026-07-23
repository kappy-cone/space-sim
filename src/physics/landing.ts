// Landing autopilot: executes exactly the burn the suicide-burn predictor
// recommends — retrograde, full throttle when the radar altitude reaches
// the predicted burn altitude, then throttle-modulated final descent.
// This is both the auto-land control in the game and the predictor's
// self-test: if predictor and integrator disagree, the touchdown fails.

import { Sim } from './sim';

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
    sim.attitude = sim.vSpeed > 15 ? { mode: 'surfaceRetrograde' } : { mode: 'vertical' };

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
        const tMax = stage.engines.reduce((s, gr) => s + gr.engine.thrustVac * gr.count, 0) || 1;
        void p;
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
