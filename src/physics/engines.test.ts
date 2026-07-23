// Per-engine operating limits: min-throttle floors (an engine cannot run
// below its floor — commands in (0, floor) run AT the floor) and ignition
// budgets (lighting from spun-down consumes one; out of ignitions means
// the stage stays dark and the failure names the limit).

import { describe, expect, it } from 'vitest';
import { engineById, tankById } from './parts';
import { Sim } from './sim';
import { vec } from './vec2';
import { speedOfSound } from './atmosphere';
import { Vehicle, stageIgnitionLimit, stageMinThrottle } from './vehicle';

function vacuumShip(engineId: string): Sim {
  const vehicle: Vehicle = {
    stages: [{ engines: [{ engine: engineById(engineId), count: 1 }], tanks: [tankById('tank-s')] }],
    payloadMass: 1_000,
    cd: 0.5,
    area: 5,
  };
  const sim = new Sim(vehicle);
  // Circular vacuum orbit so the regime is powered-only when burning.
  const r = sim.body.radius + 300_000;
  const v = Math.sqrt(sim.body.mu / r);
  sim.landed = false;
  sim.state = { r: vec(r, 0), v: vec(0, v), theta: Math.PI / 2, omega: 0, m: sim.state.m, t: 0 };
  return sim;
}

describe('min-throttle floor', () => {
  it('a 10% command on a Merlin runs at the 40% floor', () => {
    const sim = vacuumShip('merlin-1d');
    sim.throttle = 0.1;
    for (let i = 0; i < 100; i++) sim.step(0.05); // several spool time-constants
    expect(sim.actualThrottle).toBeGreaterThan(0.38);
    expect(sim.actualThrottle).toBeLessThan(0.42);
  });

  it('stage aggregates take the highest floor and the scarcest ignition budget', () => {
    const stage = {
      engines: [
        { engine: engineById('merlin-1d'), count: 2 }, // floor 0.4, 3 lights
        { engine: engineById('rl10b-2'), count: 1 }, // fixed thrust, 3 lights
      ],
      tanks: [tankById('tank-s')],
    };
    expect(stageMinThrottle(stage)).toBe(1);
    expect(stageIgnitionLimit(stage)).toBe(3);
  });
});

describe('ignition budget', () => {
  it('a Merlin Vacuum stage gets 3 lights; the fourth is denied and named', () => {
    const sim = vacuumShip('merlin-vac');
    const burnCoast = () => {
      sim.throttle = 1;
      for (let i = 0; i < 60; i++) sim.step(0.05); // light + burn 3 s
      sim.throttle = 0;
      for (let i = 0; i < 100; i++) sim.step(0.05); // spool fully down
    };
    for (let n = 1; n <= 3; n++) {
      burnCoast();
      expect(sim.ignitionsUsed[0]).toBe(n);
    }
    sim.throttle = 1; // ignition 4: denied
    for (let i = 0; i < 40; i++) sim.step(0.05);
    expect(sim.actualThrottle).toBe(0);
    const denied = sim.events.find((e) => e.type === 'ignitionFailed');
    expect(denied).toBeDefined();
    if (denied?.type === 'ignitionFailed') expect(denied.limit).toBe(3);
  });

  it('the ground-lit RS-25 cannot relight in flight', () => {
    const sim = vacuumShip('rs-25');
    sim.throttle = 1;
    for (let i = 0; i < 40; i++) sim.step(0.05);
    sim.throttle = 0;
    for (let i = 0; i < 100; i++) sim.step(0.05);
    sim.throttle = 1;
    for (let i = 0; i < 40; i++) sim.step(0.05);
    expect(sim.actualThrottle).toBe(0);
    expect(sim.events.some((e) => e.type === 'ignitionFailed')).toBe(true);
  });
});

/** Level flight at `alt` and Mach `mach`, single jet engine, full tanks. */
function jetShip(engineId: string, alt: number, mach: number): Sim {
  const vehicle: Vehicle = {
    stages: [{
      engines: [{ engine: engineById(engineId), count: 1 }],
      tanks: [{ id: 'jt', name: 'Jet fuel tank', fluid: 'jetfuel', volume: 2.5, propellantMass: 2_000, dryMass: 88, source: 'synthetic test tank' }],
      extraDryMass: 8_000,
    }],
    payloadMass: 0,
    cd: 0.01, // minimal drag so the flow state holds through the check window
    area: 1,
  };
  const sim = new Sim(vehicle);
  const r = sim.body.radius + alt;
  const speed = mach * speedOfSound(alt);
  sim.landed = false;
  sim.state = {
    r: vec(r, 0),
    v: vec(0, sim.body.rotationRate * r + speed),
    theta: Math.PI / 2, // nose along the airflow
    omega: 0,
    m: sim.state.m,
    t: 0,
  };
  return sim;
}

const spool = (sim: Sim, ticks = 60): void => {
  sim.throttle = 1;
  for (let i = 0; i < ticks; i++) sim.step(0.05);
};

describe('air-breathing engines', () => {
  it('CFM56 hits the published cruise thrust point (M0.8 / FL350)', () => {
    // Published CFM56-5B cruise thrust ≈ 23–26 kN at M0.8, 35,000 ft.
    // The f(M) table was tuned ONCE to land this and is now frozen —
    // this test is the calibration pin.
    const sim = jetShip('cfm56', 10_668, 0.8);
    spool(sim);
    expect(sim.thrustNow).toBeGreaterThan(22_000);
    expect(sim.thrustNow).toBeLessThan(27_000);
  });

  it('the fuel-only Isp gap vs a kerolox rocket is ~20× (the headline)', () => {
    expect(engineById('cfm56').ispVac / engineById('merlin-1d').ispVac).toBeGreaterThan(20);
  });

  it('flames out above the density floor ceiling, with the limit named', () => {
    const sim = jetShip('cfm56', 20_000, 0.8); // ρ(20 km) ≈ 0.089 < 0.28 floor
    spool(sim);
    expect(sim.thrustNow).toBe(0);
    const ev = sim.events.find((e) => e.type === 'jetFlameout');
    expect(ev).toBeDefined();
    if (ev?.type === 'jetFlameout') expect(ev.reason).toContain('density');
  });

  it('relights on its own when the envelope returns (windmill)', () => {
    const sim = jetShip('cfm56', 20_000, 0.8);
    spool(sim);
    expect(sim.jetOut.has(0)).toBe(true);
    // Hand the state back into the envelope.
    const r = sim.body.radius + 9_000;
    sim.state = { ...sim.state, r: vec(r, 0), v: vec(0, sim.body.rotationRate * r + 0.7 * speedOfSound(9_000)) };
    spool(sim, 40);
    expect(sim.jetOut.has(0)).toBe(false);
    expect(sim.thrustNow).toBeGreaterThan(0);
  });

  it('the ramjet needs a boost: dead at M0.9, alive at M2.5', () => {
    const cold = jetShip('rj43', 5_000, 0.9);
    spool(cold);
    expect(cold.thrustNow).toBe(0);
    const ev = cold.events.find((e) => e.type === 'jetFlameout');
    if (ev?.type === 'jetFlameout') expect(ev.reason).toContain('light-off');
    const hot = jetShip('rj43', 15_000, 2.5);
    spool(hot);
    expect(hot.thrustNow).toBeGreaterThan(0);
  });

  it('jets burn fuel at ṁ = tsfc·T — no oxidizer', () => {
    const sim = jetShip('cfm56', 5_000, 0.6);
    spool(sim);
    const m0 = sim.state.m;
    const t0 = sim.state.t;
    const thrust0 = sim.thrustNow;
    for (let i = 0; i < 100; i++) sim.step(0.05);
    const burned = m0 - sim.state.m;
    const expected = engineById('cfm56').airBreathing!.tsfc * thrust0 * (sim.state.t - t0);
    expect(Math.abs(burned - expected) / expected).toBeLessThan(0.05);
  });
});
