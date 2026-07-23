// Project-wide calibration tests: determinism, integrator order, the
// RK4↔Kepler seam, and full Δv loss accounting against published ranges.

import { describe, expect, it } from 'vitest';
import { Autopilot, defaultPlan } from './autopilot';
import { CelestialBody } from './bodies';
import { MU_EARTH, R_EARTH } from './constants';
import { FlightState, rk4Step } from './integrator';
import { propagateKepler } from './kepler';
import { Sim } from './sim';
import { norm, scale, sub, vec } from './vec2';
import { compile } from '../craft/compile';
import { referenceCraft } from '../craft/craft';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('determinism', () => {
  it('two identical ascent runs are bit-identical', () => {
    const run = () => {
      const compiled = compile(referenceCraft());
      const sim = new Sim(compiled.vehicle);
      const ap = new Autopilot(defaultPlan(250_000, sim.body));
      for (let i = 0; i < 2_000; i++) {
        ap.update(sim);
        sim.step(0.25);
      }
      return JSON.stringify([sim.state, sim.propellant, sim.idealDv, sim.gravityLoss, sim.aeroLoss]);
    };
    expect(run()).toBe(run());
  });
});

describe('RK4 convergence order', () => {
  it('halving dt cuts the error ~16× (4th order) on a gravity arc', () => {
    const r0 = R_EARTH + 300_000;
    const v0 = Math.sqrt(MU_EARTH / r0) * 1.05;
    const gravity = (st: FlightState) => {
      const rn = norm(st.r);
      return { dv: scale(st.r, -MU_EARTH / (rn * rn * rn)), domega: 0, dm: 0 };
    };
    const integrate = (dt: number, T: number): FlightState => {
      let s: FlightState = { r: vec(r0, 0), v: vec(0, v0), theta: 0, omega: 0, m: 1, t: 0 };
      for (let t = 0; t < T - 1e-9; t += dt) s = rk4Step(s, dt, gravity);
      return s;
    };
    const T = 512; // s, commensurate with all dt choices
    const reference = integrate(0.125, T);
    const err = (dt: number) => norm(sub(integrate(dt, T).r, reference.r));
    const ratio1 = err(8) / err(4);
    const ratio2 = err(4) / err(2);
    // 4th order → 16; allow slack for reference-error contamination.
    expect(ratio1).toBeGreaterThan(11);
    expect(ratio1).toBeLessThan(22);
    expect(ratio2).toBeGreaterThan(11);
    expect(ratio2).toBeLessThan(22);
  });
});

describe('the RK4 ↔ Kepler seam', () => {
  // A body with a vacuum "atmosphere" zone forces the sim to integrate
  // below 200 km and ride rails above — an orbit crossing that boundary
  // exercises the handoff both ways.
  const seamBody: CelestialBody = {
    id: 'seam-test',
    name: 'SeamTest',
    mu: MU_EARTH,
    radius: R_EARTH,
    rotationRate: 0,
    soi: Infinity,
    parent: null,
    orbit: null,
    atmosphere: { density: () => 0, pressure: () => 0, topAltitude: 200_000 },
  };

  it('an orbit straddling the handoff altitude returns to its start', () => {
    const rp = R_EARTH + 150_000; // integrated zone
    const ra = R_EARTH + 400_000; // on-rails zone
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);

    const sim = new Sim(
      { stages: [{ engines: [], tanks: [] }], payloadMass: 0, cd: 0.5, area: 10 },
      seamBody,
    );
    sim.landed = false;
    sim.throttle = 0;
    sim.state = { r: vec(rp, 0), v: vec(0, vp), theta: 0, omega: 0, m: 1_000, t: 0 };

    // March one full period in chunks so the sim crosses the seam itself.
    const chunk = period / 400;
    for (let i = 0; i < 400; i++) sim.step(chunk);

    expect(norm(sub(sim.state.r, vec(rp, 0))) / rp).toBeLessThan(1e-5);
    expect(norm(sub(sim.state.v, vec(0, vp))) / vp).toBeLessThan(1e-5);
    // And against the pure-Kepler oracle at an intermediate time too.
    const oracle = propagateKepler(vec(rp, 0), vec(0, vp), period);
    expect(norm(sub(sim.state.r, oracle.r)) / rp).toBeLessThan(1e-5);
  });
});

describe('Δv loss accounting', () => {
  it('ideal − gravity − aero − steering = actual, and each term is in the published range', () => {
    const compiled = compile(referenceCraft());
    const sim = new Sim(compiled.vehicle);
    const ap = new Autopilot(defaultPlan(250_000, sim.body));
    const atmTop = sim.body.atmosphere!.topAltitude;
    const v0 = norm(sim.state.v);
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 8_000) {
      ap.update(sim);
      const coasting = !sim.burning && sim.actualThrottle < 0.01 && sim.altitude > atmTop;
      sim.step(coasting ? Math.max(1, sim.elements.timeToApo / 20) : 0.25);
    }
    expect(ap.phase).toBe('done');

    // The identity: Δ|v| = ideal − gravity − aero − steering. Exact up to
    // the trapezoid accumulation; the budget must balance.
    const actualGain = norm(sim.state.v) - v0;
    const predicted = sim.idealDv - sim.gravityLoss - sim.aeroLoss - sim.steeringLoss;
    expect(Math.abs(actualGain - predicted) / sim.idealDv).toBeLessThan(2e-3);

    // Published figures for a real launcher to LEO (Wikipedia delta-v
    // budget; Stanford AA284A launch notes): gravity 1.0–2.2 km/s, drag
    // ~0.05–0.15 km/s (drag being small is the point), steering small.
    expect(sim.gravityLoss).toBeGreaterThan(1_000);
    expect(sim.gravityLoss).toBeLessThan(2_400);
    expect(sim.aeroLoss).toBeGreaterThan(20);
    expect(sim.aeroLoss).toBeLessThan(300);
    expect(sim.steeringLoss).toBeLessThan(600);
    // Expended Δv + the ~465 m/s Earth-rotation credit ≈ the commonly
    // cited 9.0–10 km/s surface-to-LEO budget.
    expect(sim.idealDv + v0).toBeGreaterThan(9_000);
    expect(sim.idealDv + v0).toBeLessThan(10_000);
  });
});
