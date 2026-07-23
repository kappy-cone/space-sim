// Combat model: proportional-navigation convergence, the lethal-radius
// intercept, determinism, and a full 3-v-3 engagement (whose play-by-
// play is logged for the report).

import { describe, expect, it } from 'vitest';
import { vec, norm, sub } from '../physics/vec2';
import { leadIntercept, proNavAccel, steerByProNav } from './guidance';
import { narrateDogfight, simulateDogfight } from './dogfight';

describe('proportional navigation', () => {
  it('gives no command against an opening target, a command against a crossing one', () => {
    const rM = vec(0, 0);
    const vM = vec(300, 0);
    // Target ahead, flying away faster — opening: no command.
    expect(proNavAccel(rM, vM, vec(1000, 0), vec(400, 0))).toBe(0);
    // Target crossing left-to-right ahead: nonzero LOS rate ⇒ command.
    const a = proNavAccel(rM, vM, vec(2000, 500), vec(0, -100));
    expect(Math.abs(a)).toBeGreaterThan(0);
  });

  it('a PN missile intercepts a crossing target from a lead-collision start', () => {
    // Missile at origin doing 800 m/s; target crossing at 250 m/s.
    let mPos = vec(0, 0);
    let mVel = vec(800, 0);
    let tPos = vec(6000, 1500);
    const tVel = vec(-40, -250);
    const dt = 0.02;
    let minMiss = Infinity;
    for (let t = 0; t < 20; t += dt) {
      mVel = steerByProNav(mPos, mVel, tPos, tVel, dt, (30 * 9.80665) / norm(mVel));
      mPos = { x: mPos.x + mVel.x * dt, y: mPos.y + mVel.y * dt };
      tPos = { x: tPos.x + tVel.x * dt, y: tPos.y + tVel.y * dt };
      minMiss = Math.min(minMiss, norm(sub(tPos, mPos)));
      if (minMiss < 12) break;
    }
    expect(minMiss).toBeLessThan(12); // inside lethal radius
  });

  it('leadIntercept aims ahead of a crossing target, degrades to pursuit when too slow', () => {
    const lead = leadIntercept(vec(0, 0), 800, vec(5000, 0), vec(0, 300));
    expect(lead.y).toBeGreaterThan(0); // aim ahead (target moving +y)
    // A pursuer slower than the fleeing target: no solution → current pos.
    const chase = leadIntercept(vec(0, 0), 100, vec(5000, 0), vec(300, 0));
    expect(chase).toEqual(vec(5000, 0));
  });
});

describe('3-v-3 dogfight', () => {
  it('is deterministic for a given seed', () => {
    const a = simulateDogfight({ seed: 7 });
    const b = simulateDogfight({ seed: 7 });
    expect(b.events).toEqual(a.events);
    expect(b.winner).toBe(a.winner);
  });

  it('terminates with a valid outcome and consistent bookkeeping', () => {
    const r = simulateDogfight({ seed: 7 });
    expect(['A', 'B', 'draw']).toContain(r.winner);
    expect(r.survivors.A.length + r.survivors.B.length).toBeLessThanOrEqual(6);
    expect(r.hits).toBeLessThanOrEqual(r.shots);
    // Someone shot, someone died — it was a fight, not a fly-by.
    expect(r.shots).toBeGreaterThan(0);
    expect(6 - r.survivors.A.length - r.survivors.B.length).toBe(r.hits);
    // The winner (if any) kept more jets than the loser.
    if (r.winner !== 'draw') {
      const w = r.winner === 'A' ? r.survivors.A.length : r.survivors.B.length;
      const l = r.winner === 'A' ? r.survivors.B.length : r.survivors.A.length;
      expect(w).toBeGreaterThan(l);
    }
  });

  it('play-by-play (logged for the report)', () => {
    const r = simulateDogfight({ seed: 7 });
    const lines = narrateDogfight(r);
    // eslint-disable-next-line no-console
    console.log('\n=== 3v3 DOGFIGHT (seed 7) ===\n' + lines.join('\n') +
      `\n\nShots: ${r.shots}  Hits: ${r.hits}  Duration: ${r.duration.toFixed(1)}s\n`);
    expect(lines.length).toBeGreaterThan(3);
  });
});
