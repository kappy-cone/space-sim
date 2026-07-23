// Landing validation: the suicide-burn predictor is self-tested by having
// the landing autopilot execute exactly the burn it recommends; touchdown
// adjudication limits produce named failures; parachutes respect their
// envelope and reach the analytic terminal velocity.

import { describe, expect, it } from 'vitest';
import { EARTH, bodyById } from './bodies';
import { engineById, tankById } from './parts';
import { LandingAutopilot } from './landing';
import { GeomPart, VehicleGeometry } from './massmodel';
import { Sim, TOUCHDOWN_LIMITS } from './sim';
import { vec } from './vec2';
import { Vehicle } from './vehicle';

const part = (over: Partial<GeomPart>): GeomPart => ({
  partId: 'p',
  name: 'part',
  stage: 0,
  y: 0,
  height: 1,
  radius: 0.5,
  lateral: 0,
  dryMass: 0,
  propellant: 0,
  cnAlpha: 0,
  yCp: 0,
  maxQ: 1e9,
  shedable: false,
  ...over,
});

/** Small powered lander: probe + 2 t tank + 2× Rutherford, legs. */
function lander(footprint = 2.2): { vehicle: Vehicle; geom: VehicleGeometry } {
  const tank = tankById('tank-xs');
  const geom: VehicleGeometry = {
    parts: [
      part({ partId: 'eng', dryMass: 70, y: 0, height: 0.7, radius: 0.3 }),
      part({ partId: 'tank', dryMass: tank.dryMass, propellant: tank.propellantMass, y: 0.7, height: 1.8, radius: 0.6 }),
      part({ partId: 'pod', dryMass: 1_000, y: 2.5, height: 0.9, radius: 0.6, cnAlpha: 2, yCp: 3.1 }),
      part({ partId: 'legs', dryMass: 4 * 60, y: 0.2, height: 1.4, radius: 0.1, lateral: 0.7 }),
    ],
    refDiameter: 1.2,
    refArea: Math.PI * 0.36,
    length: 3.4,
    legs: [{ partId: 'legs', stage: 0, footprint }],
    chutes: [],
  };
  const vehicle: Vehicle = {
    stages: [{ engines: [{ engine: engineById('rutherford'), count: 2 }], tanks: [tank], extraDryMass: 1_240 }],
    payloadMass: 0,
    cd: 0.5,
    area: Math.PI * 0.36,
    geometry: geom,
    rcsTorque: 100,
  };
  return { vehicle, geom };
}

/** Put a sim into free fall at `alt` with zero airspeed over the pad. */
function dropAt(sim: Sim, alt: number): void {
  const r = EARTH.radius + alt;
  sim.landed = false;
  sim.state = {
    r: vec(r, 0),
    v: vec(0, EARTH.rotationRate * r),
    theta: 0,
    omega: 0,
    m: sim.state.m,
    t: 0,
  };
}

describe('suicide burn: the autopilot flies the predictor', () => {
  it('lands from a 2.5 km drop with the predicted burn, inside leg limits', () => {
    const { vehicle } = lander();
    const sim = new Sim(vehicle);
    const ap = new LandingAutopilot();
    dropAt(sim, 2_500);
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 300) {
      ap.update(sim);
      sim.step(0.05);
    }
    expect(ap.phase).toBe('done');
    const landed = sim.events.find((e) => e.type === 'landed');
    expect(landed).toBeDefined();
    if (landed?.type === 'landed') {
      expect(landed.vSpeed).toBeLessThan(TOUCHDOWN_LIMITS.legs.vSpeed);
      // Gentle, not a scrape-through: the √-profile final descent (v_t
      // tapers from √(2·a_net·h) to 2 m/s) touches down around 4 m/s —
      // firmer than the old flat 2 m/s crawl, far inside the 6.0 limit,
      // and it no longer burns minutes of hover propellant.
      expect(landed.vSpeed).toBeLessThan(4.5);
    }
    // Landed regime is frozen: no drift over a long rest.
    const altBefore = sim.radarAltitude;
    sim.step(600);
    expect(Math.abs(sim.radarAltitude - altBefore)).toBeLessThan(1e-6);
    expect(sim.landed).toBe(true);
  });

  it('without the burn it hits hard and the failure names the limit', () => {
    const { vehicle } = lander();
    const sim = new Sim(vehicle);
    dropAt(sim, 1_500);
    sim.throttle = 0;
    sim.legsDeployed = true;
    while (!sim.crashed && !sim.hasLanded && sim.state.t < 120) sim.step(0.05);
    const fail = sim.events.find((e) => e.type === 'landingFailed');
    expect(fail).toBeDefined();
    if (fail?.type === 'landingFailed') {
      expect(fail.reason).toMatch(/vertical speed \d+\.\d m\/s, limit 6\.0/);
    }
  });

  it('narrow leg footprint + tilt → tips over, with the offset named', () => {
    const { vehicle } = lander(0.1); // pathologically narrow footprint
    const sim = new Sim(vehicle);
    sim.legsDeployed = true;
    sim.landed = false;
    sim.throttle = 0;
    // Gentle touchdown (1.5 m/s, no horizontal speed) but tilted 8° —
    // inside the tilt limit, yet the CoM plumb line misses the footprint.
    const r = EARTH.radius + 2.1; // CoM ~1.9 m up: contact within a step
    sim.state = {
      r: vec(r, 0),
      v: vec(-1.5, EARTH.rotationRate * r),
      theta: (8 * Math.PI) / 180,
      omega: 0,
      m: sim.state.m,
      t: 0,
    };
    sim.step(1);
    const fail = sim.events.find((e) => e.type === 'landingFailed');
    expect(fail).toBeDefined();
    if (fail?.type === 'landingFailed') {
      expect(fail.reason).toContain('tipped over');
      expect(fail.reason).not.toContain('vertical speed'); // only the real culprit named
    }
  });
});

describe('moon landing', () => {
  it('suicide-burns to a legs-down landing on the airless moon', () => {
    const { vehicle } = lander();
    const moon = bodyById('moon');
    const sim = new Sim(vehicle, moon);
    const ap = new LandingAutopilot();
    // Free fall from 5 km above the lunar surface, zero surface-relative
    // speed. No atmosphere: the whole descent is propulsive.
    const r = moon.radius + 5_000;
    sim.landed = false;
    sim.state = { r: vec(r, 0), v: vec(0, moon.rotationRate * r), theta: 0, omega: 0, m: sim.state.m, t: 0 };
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 600) {
      ap.update(sim);
      sim.step(0.05);
    }
    expect(ap.phase).toBe('done');
    const landed = sim.events.find((e) => e.type === 'landed');
    expect(landed).toBeDefined();
    if (landed?.type === 'landed') {
      expect(landed.vSpeed).toBeLessThan(TOUCHDOWN_LIMITS.legs.vSpeed);
    }
    // Airless: no dynamic pressure and no aero Δv loss, ever.
    expect(sim.q).toBe(0);
    expect(sim.aeroLoss).toBe(0);
    // Frozen after landing on the (slowly) rotating moon.
    const altBefore = sim.radarAltitude;
    sim.step(600);
    expect(Math.abs(sim.radarAltitude - altBefore)).toBeLessThan(1e-6);
  });

  it('lands an orbital-class arrival in two burns without running dry', () => {
    // Reproduces the failure the first full moon mission exposed: a large
    // horizontal component means the braking burn nulls the velocity far
    // above the surface. The old single-burn flow then hover-crawled down
    // from ~90 km and ran the tank dry; the fix shuts down, falls, and
    // re-arms the predictor for a terminal burn.
    const { vehicle } = lander();
    const moon = bodyById('moon');
    const sim = new Sim(vehicle, moon);
    const ap = new LandingAutopilot();
    // 60 km up with 80% of circular-orbital horizontal speed: an
    // impacting trajectory that still carries ~1.3 km/s across.
    const r = moon.radius + 60_000;
    const vOrb = Math.sqrt(moon.mu / r);
    sim.landed = false;
    sim.state = { r: vec(r, 0), v: vec(-30, 0.8 * vOrb), theta: 0, omega: 0, m: sim.state.m, t: 0 };
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 3_000) {
      ap.update(sim);
      sim.step(0.05);
    }
    expect(ap.phase).toBe('done');
    const landed = sim.events.find((e) => e.type === 'landed');
    expect(landed).toBeDefined();
    if (landed?.type === 'landed') {
      expect(landed.vSpeed).toBeLessThan(TOUCHDOWN_LIMITS.legs.vSpeed);
      expect(landed.hSpeed).toBeLessThan(TOUCHDOWN_LIMITS.legs.hSpeed);
    }
    expect(sim.propellant).toBeGreaterThan(0); // margin, not a scraped pass
    expect(sim.events.some((e) => e.type === 'ignitionFailed')).toBe(false);
  });

  it('nulls a 25 m/s horizontal drift before touchdown (no drag to help)', () => {
    const { vehicle } = lander();
    const moon = bodyById('moon');
    const sim = new Sim(vehicle, moon);
    const ap = new LandingAutopilot();
    const r = moon.radius + 6_000;
    sim.landed = false;
    // Translated descent: 25 m/s eastward surface-relative drift.
    sim.state = { r: vec(r, 0), v: vec(0, moon.rotationRate * r + 25), theta: 0, omega: 0, m: sim.state.m, t: 0 };
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 900) {
      ap.update(sim);
      sim.step(0.05);
    }
    expect(ap.phase).toBe('done');
    const landed = sim.events.find((e) => e.type === 'landed');
    expect(landed).toBeDefined();
    if (landed?.type === 'landed') {
      expect(landed.hSpeed).toBeLessThan(TOUCHDOWN_LIMITS.legs.hSpeed);
      expect(landed.vSpeed).toBeLessThan(TOUCHDOWN_LIMITS.legs.vSpeed);
    }
  });
});

describe('parachutes', () => {
  function capsule(): Vehicle {
    const geom: VehicleGeometry = {
      parts: [part({ partId: 'pod', dryMass: 4_290, y: 0, height: 2.4, radius: 1.85 })],
      refDiameter: 3.7,
      refArea: Math.PI * 1.85 * 1.85,
      length: 2.4,
      legs: [],
      chutes: [{ partId: 'chute', stage: 0, cdA: 1_400, safeQ: 2_500, y: 2.4 }],
    };
    return {
      stages: [{ engines: [], tanks: [], extraDryMass: 4_290 }],
      payloadMass: 0,
      cd: 0.5,
      area: 10.75,
      geometry: geom,
      rcsTorque: 400,
    };
  }

  it('under canopy the capsule reaches ~terminal velocity and splashes down inside limits', () => {
    const sim = new Sim(capsule());
    dropAt(sim, 3_000);
    // Slow enough at drop: deploy immediately (q ≈ 0 < safe envelope).
    sim.deployChutes();
    expect(sim.events.some((e) => e.type === 'chuteDeployed')).toBe(true);
    while (!sim.crashed && !sim.hasLanded && sim.state.t < 600) sim.step(0.05);
    expect(sim.hasLanded).toBe(true);
    const landed = sim.events.find((e) => e.type === 'landed');
    if (landed?.type === 'landed') {
      // Analytic terminal velocity at sea level: √(2mg/(ρ·ΣCdA)).
      const cdATotal = 1_400 + 0.5 * 10.75;
      const vt = Math.sqrt((2 * 4_290 * 9.798) / (1.225 * cdATotal));
      expect(landed.vSpeed).toBeGreaterThan(vt * 0.85);
      expect(landed.vSpeed).toBeLessThan(vt * 1.15);
      expect(landed.vSpeed).toBeLessThan(TOUCHDOWN_LIMITS.chute.vSpeed);
    }
  });

  it('deploying above the safe-q envelope tears the canopy', () => {
    const sim = new Sim(capsule());
    dropAt(sim, 8_000);
    // Free-fall until well over the envelope, then pull the handle.
    while (sim.q < 6_000 && sim.state.t < 120 && !sim.crashed) sim.step(0.05);
    expect(sim.q).toBeGreaterThan(2_500);
    sim.deployChutes();
    expect(sim.events.some((e) => e.type === 'partTorn')).toBe(true);
    expect(sim.activeChutes()).toHaveLength(0);
  });
});
