// Landing autopilot: executes exactly the burn the suicide-burn predictor
// recommends — retrograde, full throttle when the radar altitude reaches
// the predicted burn altitude, then throttle-modulated final descent.
// This is both the auto-land control in the game and the predictor's
// self-test: if predictor and integrator disagree, the touchdown fails.
//
// Orbital-class arrivals (large horizontal velocity) land in TWO burns:
// the braking burn kills the total velocity, which on such trajectories
// happens far above the surface — the autopilot then shuts down, falls,
// and lets the re-armed predictor time a second, terminal burn. (The
// original single-burn flow tried to descend from wherever the braking
// burn ended — 90 km up on a translunar arrival — and ran the tank dry.)

import { Sim } from './sim';
import { stageMinThrottle, stageThrustAtPressure } from './vehicle';
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
    // Attitude by phase: a braking burn ALWAYS points against the total
    // surface-relative velocity (gating on vertical speed once pointed
    // the thrust upward two seconds into a shallow braking burn — with
    // km/s of horizontal still alive, that is an escape burn, not a
    // landing). Terminal flight flies near-vertical with a small tilt
    // against residual drift: a_h = −k·v_h with thrust ≈ m·g, so
    // tilt = asin(k·v_h/g), capped ±0.2 rad.
    if (this.phase === 'burn' || norm(sim.airspeedVec) > 15) {
      sim.attitude = { mode: 'surfaceRetrograde' };
    } else {
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
        // Exit on the TOTAL surface-relative speed: on shallow arrivals
        // the vertical component dies in seconds while the horizontal
        // still carries km/s — the braking burn isn't done until all of
        // it is.
        if (norm(sim.airspeedVec) < FINAL_DESCENT_SPEED * 3) {
          if (radar < 500) {
            // The √(g·h) descent profile makes a few hundred metres of
            // final descent cheap; re-arming for another hop from here
            // would spend an ignition for nothing.
            this.phase = 'final';
          } else {
            // Velocity nulled far above the surface: an orbital-class
            // descent, where the braking burn spends most of its Δv on
            // the horizontal component. Shut down and fall — hovering
            // down from here costs far more than the terminal burn the
            // re-armed predictor will time near the ground.
            sim.throttle = 0;
            this.phase = 'fall';
          }
        }
        break;
      }
      case 'final': {
        // Hold a gentle descent: thrust ≈ m·(g + k·(v − v_target)).
        const rn = Math.hypot(sim.state.r.x, sim.state.r.y);
        const g = sim.body.mu / (rn * rn);
        const stage = sim.vehicle.stages[sim.stageIndex];
        if (!stage) break;
        const p = sim.body.atmosphere?.pressure(Math.max(0, sim.altitude)) ?? 0;
        const tMax = stageThrustAtPressure(stage, p) || 1;
        // Proportional descent profile tapering to touchdown speed at the
        // ground (a flat 2 m/s crawl from ~100 m wastes minutes of hover
        // propellant). The ceiling is the max-arrest parabola
        // v² = 2·a_net·h with a_net = thrust/m − g; commanding 70% of it
        // leaves 2× stopping margin on any body.
        const aNet = Math.max(0.2, tMax / sim.state.m - g);
        const vT = Math.max(FINAL_DESCENT_SPEED, 0.7 * Math.sqrt(2 * aNet * Math.max(0, radar)));
        // Feed-forward the profile's own deceleration (following
        // v = 0.7·√(2·a_net·h) requires braking at 0.49·a_net on top of
        // hover) — a pure PD lags the shrinking target and lands hot.
        // Fade it out below ~10 m/s of profile speed: near touchdown it
        // can exceed hover thrust on a weak body and push the lander
        // back up instead of letting it settle.
        const aFF =
          0.49 * aNet * Math.min(1, Math.max(0, (vT - FINAL_DESCENT_SPEED) / (4 * FINAL_DESCENT_SPEED)));
        const want = sim.state.m * (g + aFF + 1.2 * (sim.vSpeed - vT));
        let cmd = want / tMax;
        // Min-throttle floors: when even the floor over-brakes (low-mass
        // lander on a weak body), a steady slow descent is physically
        // impossible — the engine pulses. Cut for good once the free fall
        // from here stays inside the touchdown limits (v² = v₀² + 2gh
        // comfortably under the 6 m/s leg limit from ~6 m), instead of
        // pulsing away the ignition budget at the last moment.
        const floor = stageMinThrottle(stage);
        if (cmd < floor && cmd > 0) {
          const vImpact = Math.sqrt(Math.max(0, sim.vSpeed) ** 2 + 2 * g * Math.max(0, radar));
          cmd = vImpact < 5.0 ? 0 : floor;
        }
        sim.throttle = Math.min(1, Math.max(0, cmd));
        break;
      }
      case 'done':
      case 'failed':
        break;
    }
  }
}
