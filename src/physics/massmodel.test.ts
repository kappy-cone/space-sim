// Mass-distribution and aerodynamic-stability checks: inertia against the
// cylinder closed form, CoM shift from propellant settling, Barrowman
// component sanity, and the headline dynamic behavior — a stable vehicle
// (CoP aft of CoM) weathervanes back to prograde, an unstable one diverges.

import { describe, expect, it } from 'vitest';
import { EARTH } from './bodies';
import { GeomPart, VehicleGeometry, finSet, massProperties, noseCone, transition } from './massmodel';
import { Sim } from './sim';
import { vec } from './vec2';
import { Vehicle } from './vehicle';

const basePart = (over: Partial<GeomPart>): GeomPart => ({
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

describe('mass properties', () => {
  it('single dry cylinder matches I = m(3r² + h²)/12', () => {
    const m = 1000;
    const r = 0.5;
    const h = 10;
    const geom: VehicleGeometry = {
      parts: [basePart({ dryMass: m, height: h, radius: r })],
      refDiameter: 1,
      refArea: Math.PI * r * r,
      length: h,
      legs: [],
      chutes: [],
    };
    const p = massProperties(geom, 0, 0);
    expect(p.yCoM).toBeCloseTo(h / 2, 9);
    expect(p.inertia).toBeCloseTo((m * (3 * r * r + h * h)) / 12, 6);
  });

  it('CoM drops as propellant settles and drains in a top-mounted tank', () => {
    const geom: VehicleGeometry = {
      parts: [
        basePart({ partId: 'base', dryMass: 500, y: 0, height: 2 }),
        basePart({ partId: 'tank', dryMass: 100, propellant: 1000, y: 2, height: 8 }),
      ],
      refDiameter: 1,
      refArea: 1,
      length: 10,
      legs: [],
      chutes: [],
    };
    const full = massProperties(geom, 0, 1);
    const half = massProperties(geom, 0, 0.5);
    const empty = massProperties(geom, 0, 0);
    // Full: propellant centroid at tank center (y=6). Half: column bottom
    // half (centroid y=4) AND less mass. Both effects lower the CoM.
    expect(half.yCoM).toBeLessThan(full.yCoM);
    expect(empty.yCoM).toBeLessThan(half.yCoM);
    // Hand check at full: (500·1 + 100·6 + 1000·6)/1600 = 4.4375
    expect(full.yCoM).toBeCloseTo(4.4375, 6);
    // Half: (500·1 + 100·6 + 500·4)/1100 = 2.8181…
    expect(half.yCoM).toBeCloseTo(3100 / 1100, 6);
  });
});

describe('Barrowman components', () => {
  it('cone nose: C_Nα = 2 at reference diameter, CoP at 2/3 L from tip', () => {
    const n = noseCone(2, 3, 2);
    expect(n.cn).toBeCloseTo(2, 12);
    expect(n.xFromTip).toBeCloseTo(2, 12);
  });

  it('boat-tail transition gives negative C_Nα, shoulder positive', () => {
    expect(transition(2, 1, 1, 2).cn).toBeLessThan(0);
    expect(transition(1, 2, 1, 2).cn).toBeGreaterThan(0);
  });

  it('fin set: C_Nα grows with span and count; interference factor > 1', () => {
    const f1 = finSet(3, 1, 0.5, 1, 0.5, 0.5, 1);
    const f2 = finSet(3, 1, 0.5, 2, 0.5, 0.5, 1);
    const f3 = finSet(4, 1, 0.5, 1, 0.5, 0.5, 1);
    expect(f2.cn).toBeGreaterThan(f1.cn);
    expect(f3.cn).toBeGreaterThan(f1.cn);
    // CoP sits within the chord.
    expect(f1.xFromRootLE).toBeGreaterThan(0);
    expect(f1.xFromRootLE).toBeLessThan(1.5);
  });
});

describe('aerodynamic stability dynamics', () => {
  // A 12 m stick flying horizontally at 250 m/s at 2 km, pitched 10° off
  // the airflow, unpowered, no RCS. With tail fins it must weathervane
  // back; without them (CoP at the nose, ahead of CoM) it must diverge.
  function flyStick(withFins: boolean): { initialAoa: number; finalAoa: number; margin: number } {
    const parts: GeomPart[] = [
      basePart({ partId: 'body', dryMass: 900, y: 0, height: 10 }),
      basePart({ partId: 'nose', dryMass: 100, y: 10, height: 2, cnAlpha: 2, yCp: 10 + 2 / 3 }),
    ];
    if (withFins) {
      parts.push(basePart({ partId: 'fins', dryMass: 40, y: 0, height: 1, cnAlpha: 10, yCp: 0.4, shedable: true }));
    }
    const geom: VehicleGeometry = { parts, refDiameter: 1, refArea: Math.PI * 0.25, length: 12, legs: [], chutes: [] };
    const vehicle: Vehicle = {
      stages: [{ engines: [], tanks: [] }],
      payloadMass: 0,
      cd: 0.5,
      area: Math.PI * 0.25,
      geometry: geom,
      rcsTorque: 0,
    };
    const sim = new Sim(vehicle);
    const props = massProperties(geom, 0, 0);
    const r = vec(EARTH.radius + 2_000, 0);
    const vAir = 250;
    const v = vec(0, vAir + EARTH.rotationRate * (EARTH.radius + 2_000));
    sim.landed = false;
    sim.throttle = 0;
    sim.state = {
      r,
      v,
      theta: Math.PI / 2 + (10 * Math.PI) / 180, // 10° off the airflow
      omega: 0,
      m: props.mass,
      t: 0,
    };
    const initialAoa = (10 * Math.PI) / 180;
    for (let i = 0; i < 120; i++) sim.step(0.05); // 6 s
    return { initialAoa, finalAoa: Math.abs(sim.aoa), margin: props.staticMarginCal };
  }

  it('fins aft (positive static margin) → restoring: AoA shrinks', () => {
    const r = flyStick(true);
    expect(r.margin).toBeGreaterThan(1); // calibers, stable
    expect(r.finalAoa).toBeLessThan(r.initialAoa * 0.5);
  });

  it('no fins (CoP ahead of CoM) → divergent: the vehicle flips', () => {
    const r = flyStick(false);
    expect(r.margin).toBeLessThan(0); // unstable
    expect(r.finalAoa).toBeGreaterThan(Math.PI / 4); // > 45° — tumbling
  });
});
