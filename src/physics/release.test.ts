// Air-launch release: the compile split (carrier carries the payload as
// an engineless lumped stage whose sepMass equals the sub-vehicle's wet
// mass EXACTLY), conservation at the release event, independent
// propagation, and step-order determinism.

import { describe, expect, it } from 'vitest';
import { compile } from '../craft/compile';
import { starterCrafts } from '../craft/craft';
import { massFromStage } from './vehicle';
import { Sim } from './sim';
import { add, norm, scale, sub } from './vec2';

const airLauncher = () => compile(starterCrafts().find((s) => s.name === 'Air Launcher')!.craft);

describe('release compile split', () => {
  it('the payload compiles as an engineless stage massing exactly the sub-vehicle', () => {
    const c = airLauncher();
    expect(c.released).toBeDefined();
    const rel = c.released![0]!;
    const k = rel.sectionBurnIndex;
    expect(c.stages[k]!.released).toBe(true);
    // Engineless, poolless on the carrier side…
    expect(c.vehicle.stages[k]!.engines.some((g) => !g.engine)).toBe(false);
    expect(c.vehicle.pools![k]!.mass).toBe(0);
    // …and its separation mass is EXACTLY the sub-vehicle's wet mass.
    expect(c.vehicle.sepMass![k]!).toBeCloseTo(massFromStage(rel.sub.vehicle, 0), 6);
    // The dart's own staging survived the re-root: booster + ramjet stage.
    expect(rel.sub.stages.length).toBe(2);
    // The carrier's engines are NOT in the released phase's burn groups…
    const phase = c.vehicle.phases![k]!;
    expect(phase.groups.every((g) => g.stage !== k)).toBe(true);
    // …but the phase does include them (strap-on union: the carrier
    // burns straight through until the player releases).
    expect(phase.groups.length).toBeGreaterThan(0);
  });

  it('conservation at release: mass exact, momentum to the push-off impulse', () => {
    const c = airLauncher();
    const rel = c.released![0]!;
    const carrier = new Sim(c.vehicle);
    // Fly off the pin: hand it a cruise state so stage() is legal physics.
    const r = carrier.body.radius + 9_000;
    carrier.landed = false;
    carrier.state = {
      r: { x: r, y: 0 },
      v: { x: 0, y: carrier.body.rotationRate * r + 250 },
      theta: Math.PI / 2,
      omega: 0,
      m: carrier.state.m,
      t: 0,
    };
    const m0 = carrier.state.m;
    const p0 = scale(carrier.state.v, m0);
    // The release: carrier stages (mass subtraction), payload spawns
    // seeded at the carrier state with a small momentum-conserving
    // push-off pair (dv on each, opposite, mass-weighted).
    const mSub = massFromStage(rel.sub.vehicle, 0);
    carrier.stage();
    const push = 0.5; // m/s given to the payload, downward
    const rHat = scale(carrier.state.r, 1 / norm(carrier.state.r));
    const seedV = add(carrier.state.v, scale(rHat, -push));
    const payload = new Sim(rel.sub.vehicle, carrier.body, undefined, {
      r: add(carrier.state.r, scale(rHat, -4)),
      v: seedV,
      theta: carrier.state.theta,
      omega: 0,
      t: carrier.state.t,
    });
    carrier.state.v = add(carrier.state.v, scale(rHat, (push * mSub) / carrier.state.m));
    // Mass: exact.
    expect(carrier.state.m + payload.state.m).toBeCloseTo(m0, 6);
    // Momentum: conserved to float noise.
    const p1 = add(scale(carrier.state.v, carrier.state.m), scale(payload.state.v, payload.state.m));
    expect(norm(sub(p1, p0)) / norm(p0)).toBeLessThan(1e-9);
    // Both propagate NaN-free and independently.
    for (let i = 0; i < 200; i++) {
      carrier.step(0.05);
      payload.step(0.05);
    }
    expect(isFinite(carrier.state.r.x + payload.state.r.x)).toBe(true);
    expect(carrier.crashed).toBe(false);
    expect(payload.crashed).toBe(false);
  });

  it('two-vessel stepping is deterministic and non-interfering', () => {
    const run = (): string => {
      const c = airLauncher();
      const rel = c.released![0]!;
      const a = new Sim(c.vehicle);
      const r = a.body.radius + 9_000;
      a.landed = false;
      a.state = { r: { x: r, y: 0 }, v: { x: 0, y: a.body.rotationRate * r + 250 }, theta: Math.PI / 2, omega: 0, m: a.state.m, t: 0 };
      const b = new Sim(rel.sub.vehicle, a.body, undefined, {
        r: { x: r - 10, y: 0 }, v: { x: 0, y: a.body.rotationRate * r + 250 }, theta: Math.PI / 2, omega: 0, t: 0,
      });
      b.throttle = 1; // the dart's J79 boost stage lights
      for (let i = 0; i < 400; i++) {
        a.step(0.05);
        b.step(0.05);
      }
      return JSON.stringify([a.state, b.state]);
    };
    expect(run()).toBe(run());
  });
});
