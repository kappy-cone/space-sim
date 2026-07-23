// Atmosphere model checks against published USSA76 values.

import { describe, expect, it } from 'vitest';
import { density, pressure } from './atmosphere';
import { thrustAtPressure, ispAtPressure, massFlow, Engine } from './vehicle';
import { G0, P0_SEA_LEVEL } from './constants';

describe('USSA76 density (Vallado piecewise-exponential fit)', () => {
  it('sea level is 1.225 kg/m³ exactly (band base)', () => {
    expect(density(0)).toBe(1.225);
  });

  it('band bases reproduce the published table values', () => {
    expect(density(25_000)).toBeCloseTo(3.899e-2, 6);
    expect(density(100_000)).toBeCloseTo(5.297e-7, 11);
    expect(density(500_000)).toBeCloseTo(6.967e-13, 17);
  });

  it('is continuous-ish and strictly decreasing to 1000 km', () => {
    let prev = density(0);
    for (let h = 500; h <= 1_000_000; h += 500) {
      const d = density(h);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
  });

  it('negligible where we hand off to Kepler (>140 km)', () => {
    expect(density(140_000)).toBeLessThan(1e-8);
  });
});

describe('USSA76 pressure (barometric layers)', () => {
  it('reproduces published layer-base pressures', () => {
    expect(pressure(0)).toBe(101_325);
    expect(pressure(11_000)).toBeCloseTo(22_632.1, 0); // tropopause
    expect(pressure(20_000)).toBeCloseTo(5_474.89, 1);
    expect(pressure(32_000)).toBeCloseTo(868.019, 1);
    expect(pressure(47_000)).toBeCloseTo(110.906, 1);
  });

  it('is zero above the 86 km model top (engines see vacuum)', () => {
    expect(pressure(90_000)).toBe(0);
  });
});

describe('engine pressure model', () => {
  const testEngine: Engine = {
    id: 'test',
    name: 'Test Engine',
    thrustSL: 800_000,
    thrustVac: 900_000,
    ispSL: 280,
    ispVac: 315,
    mass: 500,
    vacuumOnly: false,
  };

  it('thrust interpolates linearly: endpoints exact', () => {
    expect(thrustAtPressure(testEngine, 0)).toBe(testEngine.thrustVac);
    expect(thrustAtPressure(testEngine, P0_SEA_LEVEL)).toBe(testEngine.thrustSL);
  });

  it('mass flow uses g0 and vacuum Isp', () => {
    expect(massFlow(testEngine)).toBeCloseTo(900_000 / (G0 * 315), 9);
  });

  it('Isp at vacuum recovers the vacuum rating', () => {
    expect(ispAtPressure(testEngine, 0)).toBeCloseTo(315, 9);
  });
});
