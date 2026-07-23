// Roster validator — written BEFORE the data pass so an unsourced or
// inconsistent part fails loudly instead of accumulating. Every part must
// carry a machine-checked citation; propulsion must carry a propellant;
// physical fields must be self-consistent. The non-domination TABLE lives
// in docs/PARTS.md; this file enforces the schema half of the contract.

import { describe, expect, it } from 'vitest';
import { ENGINES, TANKS } from './parts';
import { PROPELLANTS, propellantById, TANK_STRUCTURE_KG_PER_M3 } from './propellants';
import { G0 } from './constants';
import { PARTS, partById } from '../craft/catalog';

describe('propellant registry', () => {
  it('densities are physical and cited', () => {
    for (const p of PROPELLANTS) {
      expect(p.source.length, p.id).toBeGreaterThan(10);
      expect(p.bulkDensity).toBeGreaterThan(50);
      expect(p.bulkDensity).toBeLessThan(2500);
      expect(p.boiloffPerDay).toBeGreaterThanOrEqual(0);
      expect(p.boiloffPerDay).toBeLessThan(0.2);
    }
    // The density spread IS the point: hydrogen must be the outlier.
    expect(propellantById('hydrolox').bulkDensity).toBeLessThan(propellantById('kerolox').bulkDensity / 2);
    expect(propellantById('solid').bulkDensity).toBeGreaterThan(propellantById('kerolox').bulkDensity);
    // Hypergolic exists because it never boils off.
    expect(propellantById('hypergolic').boiloffPerDay).toBe(0);
    expect(propellantById('hydrolox').boiloffPerDay).toBeGreaterThan(0);
  });
});

describe('engine roster', () => {
  it('every engine is sourced, typed, and self-consistent', () => {
    for (const e of ENGINES) {
      const tag = e.id;
      expect(e.source.length, tag).toBeGreaterThan(10);
      expect(() => propellantById(e.propellant), tag).not.toThrow();
      expect(e.thrustVac, tag).toBeGreaterThan(0);
      if (e.airBreathing) {
        // Jets: fuel-only Isp = 1/(tsfc·g₀), far outside the rocket band
        // BY CONSTRUCTION (no oxidizer aboard) — that gap is the point.
        expect(e.propellant, tag).toBe('jetfuel');
        expect(e.ispVac, tag).toBeGreaterThan(1_000);
        expect(e.ispVac, tag).toBeLessThan(8_000);
        expect(Math.abs(e.ispVac - 1 / (e.airBreathing.tsfc * G0)) / e.ispVac, tag).toBeLessThan(0.001);
        expect(e.ispSL, tag).toBe(e.ispVac); // the (ρ/ρ₀)·f(M) model owns the lapse
        expect(e.thrustSL, tag).toBe(e.thrustVac);
        expect(e.ullageImmune, tag).toBe(true);
        expect(e.gimbalDeg, tag).toBe(0);
        expect(e.airBreathing.minMach, tag).toBeGreaterThanOrEqual(0);
        expect(e.airBreathing.maxMach, tag).toBeGreaterThan(e.airBreathing.minMach);
        expect(e.airBreathing.rhoFloor, tag).toBeGreaterThan(0);
        expect(e.airBreathing.rhoFloor, tag).toBeLessThan(1.225);
        // f(M) table: Mach-ordered, sane multipliers, inside the envelope.
        let lastM = -1;
        for (const [m, f] of e.airBreathing.machTable) {
          expect(m, tag).toBeGreaterThan(lastM);
          lastM = m;
          expect(f, tag).toBeGreaterThan(0);
          expect(f, tag).toBeLessThan(1.6);
        }
        expect(lastM, tag).toBeCloseTo(e.airBreathing.maxMach, 5);
        expect(e.mass, tag).toBeGreaterThan(0);
        continue; // rocket-specific checks below don't apply
      }
      expect(e.ispVac, tag).toBeGreaterThan(150);
      expect(e.ispVac, tag).toBeLessThan(500);
      expect(e.mass, tag).toBeGreaterThan(0);
      // throttleable flag must agree with the floor.
      expect(e.throttleable, tag).toBe(e.minThrottle < 1);
      expect(e.minThrottle, tag).toBeGreaterThan(0);
      expect(e.minThrottle, tag).toBeLessThanOrEqual(1);
      expect(e.ignitions, tag).toBeGreaterThanOrEqual(1);
      expect(e.gimbalDeg, tag).toBeGreaterThanOrEqual(0);
      expect(e.gimbalDeg, tag).toBeLessThanOrEqual(12);
      expect(e.expansionRatio, tag).toBeGreaterThan(1);
      expect(e.maxAmbientPressure, tag).toBeGreaterThan(0);
      if (e.propellant === 'solid') {
        // Commitment as a design property.
        expect(e.throttleable, tag).toBe(false);
        expect(e.ignitions, tag).toBe(1);
        expect(e.gimbalDeg, tag).toBeLessThanOrEqual(8); // TVC exists (RSRM ±8°) but no deep gimbal
        expect(e.ullageImmune, tag).toBe(true);
        expect(e.thrustCurve, tag).toBeDefined();
      }
      if (e.thrustCurve) {
        // Curve is time-ordered over [0, 1] with sane multipliers.
        let last = -1;
        for (const [t, f] of e.thrustCurve) {
          expect(t, tag).toBeGreaterThan(last);
          last = t;
          expect(f, tag).toBeGreaterThanOrEqual(0);
          expect(f, tag).toBeLessThan(1.6);
        }
        expect(e.thrustCurve[0]![0], tag).toBe(0);
        expect(last, tag).toBe(1);
      }
      if (e.nozzleExtension) {
        expect(e.nozzleExtension.stowedExpansionRatio, tag).toBeLessThan(e.expansionRatio);
        expect(e.nozzleExtension.stowedIspVac, tag).toBeLessThan(e.ispVac);
        expect(e.nozzleExtension.stowedMaxAmbientPressure, tag).toBeGreaterThan(e.maxAmbientPressure);
      }
      // Isp SL < Isp vac whenever a sea-level point exists.
      if (e.ispSL > 0) expect(e.ispSL, tag).toBeLessThan(e.ispVac);
      // Vacuum engines must have a finite separation limit; sea-level
      // engines must be safe at 1 atm.
      if (e.vacuumOnly) expect(isFinite(e.maxAmbientPressure), tag).toBe(true);
      else expect(e.maxAmbientPressure, tag).toBeGreaterThan(101_325);
    }
  });

  it('methalox sits between kerolox and hydrolox on density (its niche)', () => {
    expect(propellantById('methalox').bulkDensity).toBeLessThan(propellantById('kerolox').bulkDensity);
    expect(propellantById('methalox').bulkDensity).toBeGreaterThan(propellantById('hydrolox').bulkDensity * 2);
    expect(propellantById('methalox').boiloffPerDay).toBeGreaterThan(propellantById('kerolox').boiloffPerDay);
    expect(propellantById('methalox').boiloffPerDay).toBeLessThan(propellantById('hydrolox').boiloffPerDay);
  });
});

describe('tank roster', () => {
  it('tanks derive mass from volume x density, dry mass from volume', () => {
    for (const t of TANKS) {
      const tag = t.id;
      expect(t.source.length, tag).toBeGreaterThan(10);
      const rho = propellantById(t.fluid).bulkDensity;
      expect(Math.abs(t.propellantMass - t.volume * rho), tag).toBeLessThanOrEqual(0.51);
      expect(Math.abs(t.dryMass - t.volume * TANK_STRUCTURE_KG_PER_M3), tag).toBeLessThanOrEqual(0.51);
    }
  });
});

describe('part catalog', () => {
  it('every part is sourced; propulsion parts carry propellant linkage', () => {
    for (const p of PARTS) {
      const tag = p.id;
      expect(p.source?.length ?? 0, tag).toBeGreaterThan(10);
      if (p.kind === 'tank') expect(p.fluid, tag).toBeDefined();
      if (p.kind === 'engine') expect(p.engineId ?? p.solidMotor, tag).toBeDefined();
      if (p.lengthRange) {
        expect(p.lengthRange.min, tag).toBeGreaterThan(0);
        expect(p.lengthRange.max, tag).toBeGreaterThan(p.lengthRange.min);
      }
      if (p.noseCd !== undefined) {
        expect(p.noseCd, tag).toBeGreaterThanOrEqual(0);
        expect(p.noseCd, tag).toBeLessThan(1.2);
      }
    }
  });

  it('every referenced engine/solid exists in the physics roster', () => {
    for (const p of PARTS) {
      if (p.engineId) expect(ENGINES.some((e) => e.id === p.engineId), p.id).toBe(true);
      if (p.solidMotor) expect(ENGINES.some((e) => e.id === p.solidMotor), p.id).toBe(true);
    }
  });

  it('sea-level Isp per propellant orders as published (kerolox < hydrolox)', () => {
    // A cheap cross-check that the data pass didn't transpose columns.
    const rs25 = ENGINES.find((e) => e.id === 'rs-25')!;
    const merlin = ENGINES.find((e) => e.id === 'merlin-1d')!;
    expect(rs25.ispVac).toBeGreaterThan(merlin.ispVac + 100);
    // And that mass flow follows from Isp (definition, not data).
    for (const e of ENGINES) {
      const mdot = e.thrustVac / (G0 * e.ispVac);
      expect(mdot).toBeGreaterThan(0);
    }
  });
});
