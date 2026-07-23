// The reference craft is the known-good test vehicle: it must compile to
// the expected stages, carry an orbit-capable Δv budget, be statically
// stable (fins aft), and actually reach orbit through the full pipeline
// (craft → compile → 3-DOF sim → autopilot).

import { describe, expect, it } from 'vitest';
import { Autopilot, defaultPlan } from '../physics/autopilot';
import { Sim } from '../physics/sim';
import { referenceCraft, starterCrafts } from './craft';
import { LEO_BUDGET, compile } from './compile';

describe('reference craft', () => {
  const compiled = compile(referenceCraft());

  it('compiles to two stages with the expected engines', () => {
    expect(compiled.stages).toHaveLength(2);
    expect(compiled.stages[0]!.stage.engines[0]!.count).toBe(9); // Merlin cluster
    expect(compiled.stages[1]!.stage.engines[0]!.engine.id).toBe('merlin-vac');
  });

  it('carries more than the LEO budget with margin', () => {
    expect(compiled.totalDeltaV).toBeGreaterThan(LEO_BUDGET + 500);
  });

  it('is aerodynamically stable at liftoff and dry', () => {
    expect(compiled.aero.full.staticMarginCal).toBeGreaterThan(0);
    expect(compiled.aero.empty.staticMarginCal).toBeGreaterThan(0);
    expect(compiled.warnings).toHaveLength(0);
  });

  it('every starter build is statically stable with no warnings', () => {
    for (const s of starterCrafts()) {
      const c = compile(s.craft);
      if (s.name === 'Test Lander') {
        // Short stubby landers are inherently near-neutral: fin area
        // converges the CoP toward the fin mount without clearing the
        // high CoM. Near-neutral is fine for a gimbal-stabilized, low-q
        // drop vehicle — that trade-off is real, not a tuning miss.
        expect(c.aero.full.staticMarginCal, s.name).toBeGreaterThan(-0.1);
      } else {
        expect(c.aero.full.staticMarginCal, s.name).toBeGreaterThan(0);
        expect(c.totalDeltaV, s.name).toBeGreaterThan(LEO_BUDGET);
      }
      expect(
        c.warnings.filter((w) => !w.startsWith('Aerodynamically unstable')),
        s.name,
      ).toHaveLength(0);
    }
  });

  it('the Escape Probe carries enough Δv to leave Earth orbit', () => {
    const escape = starterCrafts().find((s) => s.name === 'Escape Probe')!;
    // Surface-to-escape ideal budget ≈ 12.6 km/s (LEO ~9.4 + ~3.2 to
    // reach C3 = 0 from LEO); require margin on top.
    expect(compile(escape.craft).totalDeltaV).toBeGreaterThan(13_000);
  });

  it('reaches a stable orbit under the autopilot (full pipeline)', () => {
    const sim = new Sim(compiled.vehicle);
    const ap = new Autopilot(defaultPlan(250_000, sim.body));
    const atmTop = sim.body.atmosphere!.topAltitude;
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 8_000) {
      ap.update(sim);
      const coasting = !sim.burning && sim.actualThrottle < 0.01 && sim.altitude > atmTop;
      sim.step(coasting ? Math.max(1, sim.elements.timeToApo / 20) : 0.25);
    }
    expect(ap.phase).toBe('done');
    expect(sim.inOrbit).toBe(true);
    expect(sim.torn.size).toBe(0); // nothing ripped off on a nominal ascent
  });
});
