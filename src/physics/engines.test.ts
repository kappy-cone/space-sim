// Per-engine operating limits: min-throttle floors (an engine cannot run
// below its floor — commands in (0, floor) run AT the floor) and ignition
// budgets (lighting from spun-down consumes one; out of ignitions means
// the stage stays dark and the failure names the limit).

import { describe, expect, it } from 'vitest';
import { engineById, tankById } from './parts';
import { Sim } from './sim';
import { vec } from './vec2';
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
  it('a Rutherford stage gets 2 lights; the third is denied and named', () => {
    const sim = vacuumShip('rutherford');
    const burnCoast = () => {
      sim.throttle = 1;
      for (let i = 0; i < 60; i++) sim.step(0.05); // light + burn 3 s
      sim.throttle = 0;
      for (let i = 0; i < 100; i++) sim.step(0.05); // spool fully down
    };
    burnCoast(); // ignition 1
    expect(sim.ignitionsUsed[0]).toBe(1);
    burnCoast(); // ignition 2
    expect(sim.ignitionsUsed[0]).toBe(2);
    sim.throttle = 1; // ignition 3: denied
    for (let i = 0; i < 40; i++) sim.step(0.05);
    expect(sim.actualThrottle).toBe(0);
    const denied = sim.events.find((e) => e.type === 'ignitionFailed');
    expect(denied).toBeDefined();
    if (denied?.type === 'ignitionFailed') expect(denied.limit).toBe(2);
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
