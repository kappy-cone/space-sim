// Patched-conic SOI transitions, cross-validated: a translunar transfer
// propagated through the boundary must be continuous in position and
// velocity at the handoff (checked by independently reconstructing both
// sides from snapshots), conserve specific orbital energy within each
// two-body frame segment, and produce a physically meaningful gravity
// assist (earth-frame energy changes across a lunar flyby). Detection
// must not tunnel through the SOI even when the whole transfer is asked
// for in a single step() call.

import { describe, expect, it } from 'vitest';
import { EARTH, bodyById, bodyOrbitState } from './bodies';
import { MU_EARTH, R_EARTH } from './constants';
import { elementsFromState, propagateKepler } from './kepler';
import { Sim } from './sim';
import { Vec2, add, dot, norm, sub, vec } from './vec2';
import { Vehicle } from './vehicle';

const MOON = bodyById('moon');
const coaster: Vehicle = { stages: [{ engines: [], tanks: [] }], payloadMass: 0, cd: 0.5, area: 10 };

/** A translunar setup: apogee at the moon's distance, launch angle offset
 * so the flyby periapsis is ~8,500 km from the moon's center (inside the
 * 66,200 km SOI, far above the 1,737 km surface — verified empirically;
 * lunar gravity bends the approach well inside the naive miss distance). */
function tliSim(): { sim: Sim; tHalf: number } {
  const r0 = R_EARTH + 200_000;
  const a = (r0 + MOON.orbit!.a) / 2;
  const tHalf = Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  const nMoon = Math.sqrt(MU_EARTH / MOON.orbit!.a ** 3);
  const arrival = MOON.orbit!.phase0 + nMoon * tHalf;
  const launchAngle = arrival - Math.PI + 0.22;
  const v0 = Math.sqrt(MU_EARTH * (2 / r0 - 1 / a));
  const sim = new Sim(coaster);
  sim.landed = false;
  sim.throttle = 0;
  const c = Math.cos(launchAngle);
  const s = Math.sin(launchAngle);
  sim.state = { r: vec(r0 * c, r0 * s), v: vec(-v0 * s, v0 * c), theta: 0, omega: 0, m: 1_000, t: 0 };
  return { sim, tHalf };
}

interface Snap {
  t: number;
  r: Vec2;
  v: Vec2;
  body: string;
}

describe('body ephemeris', () => {
  it('the moon orbit state is a consistent circular two-body orbit', () => {
    for (const t of [0, 86_400, 1e6]) {
      const { r, v } = bodyOrbitState(MOON, t);
      expect(norm(r)).toBeCloseTo(MOON.orbit!.a, 3);
      expect(Math.abs(dot(r, v))).toBeLessThan(1e-4 * norm(r) * norm(v) + 1e-6); // v ⊥ r
      const n = Math.sqrt(MU_EARTH / MOON.orbit!.a ** 3);
      expect(norm(v)).toBeCloseTo(n * MOON.orbit!.a, 6);
    }
  });
});

describe('patched-conic SOI transitions', () => {
  const run = () => {
    const { sim, tHalf } = tliSim();
    const snaps: Snap[] = [{ t: 0, r: sim.state.r, v: sim.state.v, body: sim.body.id }];
    const tEnd = tHalf + 4e5;
    while (sim.state.t < tEnd && !sim.crashed) {
      sim.step(300);
      snaps.push({ t: sim.state.t, r: sim.state.r, v: sim.state.v, body: sim.body.id });
      // Stop once we are back in the earth frame after the flyby.
      if (sim.events.filter((e) => e.type === 'soiTransition').length >= 2) break;
    }
    return { sim, snaps };
  };

  /** Reconstruct both sides of a handoff at the event time from the
   * nearest snapshots and compare in the parent frame. */
  const continuityError = (
    snaps: Snap[],
    tX: number,
    outerBody: string,
    innerBody: string,
    entering: boolean,
  ): { dr: number; dv: number } => {
    const before = snaps.filter((s) => s.t <= tX && s.body === (entering ? outerBody : innerBody)).pop()!;
    const after = snaps.find((s) => s.t >= tX && s.body === (entering ? innerBody : outerBody))!;
    const muOuter = EARTH.mu;
    const muInner = MOON.mu;
    const eph = bodyOrbitState(MOON, tX);
    // Outer-frame state at tX.
    const o = propagateKepler(
      (entering ? before : after).r,
      (entering ? before : after).v,
      tX - (entering ? before : after).t,
      muOuter,
    );
    // Inner-frame state at tX, mapped to the outer frame.
    const iRaw = propagateKepler(
      (entering ? after : before).r,
      (entering ? after : before).v,
      tX - (entering ? after : before).t,
      muInner,
    );
    const i = { r: add(iRaw.r, eph.r), v: add(iRaw.v, eph.v) };
    return { dr: norm(sub(o.r, i.r)), dv: norm(sub(o.v, i.v)) };
  };

  it('a translunar coast enters and exits the lunar SOI with continuous state', () => {
    const { sim, snaps } = run();
    const transitions = sim.events.filter((e) => e.type === 'soiTransition');
    expect(transitions.length).toBe(2);
    const [entry, exit] = transitions as { t: number; from: string; to: string; type: 'soiTransition' }[];
    expect(entry!.from).toBe('earth');
    expect(entry!.to).toBe('moon');
    expect(exit!.from).toBe('moon');
    expect(exit!.to).toBe('earth');

    // Continuity at both handoffs: the same inertial state expressed in
    // two frames. Tolerances cover the 1 ms crossing-time bisection.
    const e1 = continuityError(snaps, entry!.t, 'earth', 'moon', true);
    expect(e1.dr).toBeLessThan(10);
    expect(e1.dv).toBeLessThan(1e-2);
    const e2 = continuityError(snaps, exit!.t, 'earth', 'moon', false);
    expect(e2.dr).toBeLessThan(10);
    expect(e2.dv).toBeLessThan(1e-2);
  });

  it('specific orbital energy is conserved within each two-body frame segment', () => {
    const { sim, snaps } = run();
    expect(sim.events.filter((e) => e.type === 'soiTransition').length).toBe(2);
    const segEnergies = new Map<string, number[]>();
    let seg = '';
    let last = '';
    for (const s of snaps) {
      if (s.body !== last) {
        seg = `${s.body}#${s.t.toFixed(0)}`;
        last = s.body;
        segEnergies.set(seg, []);
      }
      const mu = s.body === 'earth' ? EARTH.mu : MOON.mu;
      segEnergies.get(seg)!.push(elementsFromState(s.r, s.v, mu).energy);
    }
    expect(segEnergies.size).toBe(3); // earth → moon → earth
    for (const energies of segEnergies.values()) {
      const e0 = energies[0]!;
      for (const e of energies) {
        expect(Math.abs(e - e0) / Math.abs(e0)).toBeLessThan(1e-9);
      }
    }
  });

  it('the flyby is a real gravity assist: earth-frame energy changes across it', () => {
    const { sim, snaps } = run();
    const first = snaps.find((s) => s.body === 'earth')!;
    const lastEarth = snaps[snaps.length - 1]!;
    expect(lastEarth.body).toBe('earth');
    const eBefore = elementsFromState(first.r, first.v, EARTH.mu).energy;
    const eAfter = elementsFromState(lastEarth.r, lastEarth.v, EARTH.mu).energy;
    expect(Math.abs(eAfter - eBefore) / Math.abs(eBefore)).toBeGreaterThan(1e-3);
  });

  it('a single giant step cannot tunnel through the SOI', () => {
    const { sim, tHalf } = tliSim();
    sim.step(tHalf + 2e5); // the whole transfer in one call
    const transitions = sim.events.filter((e) => e.type === 'soiTransition');
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect((transitions[0] as { to: string }).to).toBe('moon');
  });
});
