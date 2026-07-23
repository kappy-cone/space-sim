// End-to-end reference ascent: a Falcon-9-like two-stage vehicle flown by
// the ascent autopilot must reach a stable orbit. Regression guard for the
// whole pipeline: thrust/Isp vs pressure, drag, staging, RK4, Kepler coast.

import { describe, expect, it } from 'vitest';
import { Autopilot, defaultPlan } from './autopilot';
import { ATMOSPHERE_COAST_HANDOFF_ALT, R_EARTH } from './constants';
import { engineById, tankById } from './parts';
import { Sim } from './sim';
import { norm } from './vec2';
import { Vehicle, totalDeltaV } from './vehicle';

// Roughly Falcon 9 expendable with a 10 t payload.
const referenceVehicle: Vehicle = {
  stages: [
    {
      engines: [{ engine: engineById('merlin-1d'), count: 9 }],
      tanks: [tankById('tank-xl')], // 400 t propellant
    },
    {
      engines: [{ engine: engineById('merlin-vac'), count: 1 }],
      tanks: [tankById('tank-l')], // 110 t propellant
    },
  ],
  payloadMass: 10_000,
  cd: 0.5,
  area: 10.5, // ~3.66 m diameter
};

/** Fly the autopilot to completion; caller asserts on the outcome. */
function fly(vehicle: Vehicle, targetAlt: number): { sim: Sim; ap: Autopilot } {
  const sim = new Sim(vehicle);
  const ap = new Autopilot(defaultPlan(targetAlt));
  while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 8_000) {
    ap.update(sim);
    // Control tick every 0.25 s; larger steps only while coasting in vacuum
    // (Kepler makes them exact — ignition timing stays within a few seconds).
    const coasting = ap.phase === 'coast' && sim.altitude > ATMOSPHERE_COAST_HANDOFF_ALT;
    sim.step(coasting ? Math.min(30, Math.max(0.25, sim.elements.timeToApo / 20)) : 0.25);
  }
  return { sim, ap };
}

describe('reference ascent', () => {
  it('vehicle has comfortably more than the ~9.4 km/s LEO budget', () => {
    // ~9.4 km/s: 7.8 km/s orbital + 1.5–2.0 km/s gravity/drag/steering
    // losses (Wikipedia delta-v budget; Stanford AA284A launch notes).
    expect(totalDeltaV(referenceVehicle)).toBeGreaterThan(9_400);
  });

  it('reaches a stable orbit above the atmosphere', () => {
    const { sim, ap } = fly(referenceVehicle, 250_000);

    expect(sim.crashed).toBe(false);
    expect(ap.phase).toBe('done');
    expect(sim.inOrbit).toBe(true);
    const el = sim.elements;
    expect(el.e).toBeLessThan(0.05);
    expect(el.rPeri - R_EARTH).toBeGreaterThan(150_000);
    // The circularization cutoff is on orbit energy: the semi-major axis
    // must land on the target radius (regression guard — the old Pe-only
    // cutoff overshot a by +150 km given Δv margin).
    expect(Math.abs(el.a - (R_EARTH + 250_000))).toBeLessThan(15_000);
    expect(el.e).toBeLessThan(0.02);
    expect(sim.events.some((e) => e.type === 'orbit')).toBe(true);
    expect(sim.propellant).toBeGreaterThan(0); // margin, not a scraped pass

    // Let the engine spool-down transient finish (residual thrust tail),
    // then: the orbit survives 10 full Kepler periods with Pe unchanged.
    sim.step(10);
    const peBefore = sim.elements.rPeri;
    sim.step(sim.elements.period * 10);
    expect(Math.abs(sim.elements.rPeri - peBefore) / peBefore).toBeLessThan(1e-9);
  });

  it('an obviously inadequate rocket does not make orbit', () => {
    const dud: Vehicle = {
      stages: [{ engines: [{ engine: engineById('merlin-1d'), count: 1 }], tanks: [tankById('tank-s')] }],
      payloadMass: 10_000,
      cd: 0.5,
      area: 10.5,
    };
    const { sim, ap } = fly(dud, 250_000);
    expect(sim.inOrbit).toBe(false);
    expect(ap.phase).toBe('failed');
  });

  it('liftoff hands over a state continuous with the rotating pad', () => {
    const sim = new Sim(referenceVehicle);
    while (!sim.events.some((e) => e.type === 'liftoff') && sim.state.t < 30) sim.step(0.05);
    expect(sim.events.some((e) => e.type === 'liftoff')).toBe(true);
    // At release the position must be the pad's surface point at time t —
    // a pin stale by one step (ω·R·dt ≈ 23 m westward) was visible as the
    // vehicle snapping sideways off the pad.
    const upAngle = Math.atan2(sim.state.r.y, sim.state.r.x);
    const padAngle = 7.292115e-5 * sim.state.t;
    expect(Math.abs(upAngle - padAngle)).toBeLessThan(1e-9);
    expect(norm(sim.airspeedVec)).toBeLessThan(1e-6);
  });

  it('the airspeed on the pad is zero but inertial speed is Earth rotation', () => {
    const sim = new Sim(referenceVehicle);
    expect(norm(sim.airspeedVec)).toBeLessThan(1e-9);
    // ω⊕·r ≈ 465 m/s eastward — the free Δv from launching east (r = the
    // CoM's radius: surface + CoM height above the vehicle's bottom).
    expect(norm(sim.state.v)).toBeCloseTo(7.292115e-5 * norm(sim.state.r), 6);
    expect(norm(sim.state.r)).toBeGreaterThan(R_EARTH); // resting ON the pad
  });
});
