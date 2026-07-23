// Celestial body table checks — the moon row is scaffolding for patched
// conics, but its numbers must already be right.

import { describe, expect, it } from 'vitest';
import { BODIES, bodyById, laplaceSoi } from './bodies';

describe('celestial bodies', () => {
  it('the moon SOI matches the Laplace sphere from its own table values', () => {
    const moon = bodyById('moon');
    const earth = bodyById('earth');
    const soi = laplaceSoi(moon.orbit!.a, moon.mu, earth.mu);
    // 66,100–66,200 km is the commonly tabulated value.
    expect(Math.abs(soi - moon.soi) / moon.soi).toBeLessThan(0.02);
    expect(soi).toBeGreaterThan(6.0e7);
    expect(soi).toBeLessThan(7.0e7);
  });

  it('every non-root body has a parent, orbit, and finite SOI', () => {
    for (const b of BODIES) {
      if (b.parent === null) continue;
      expect(bodyById(b.parent)).toBeDefined();
      expect(b.orbit).not.toBeNull();
      expect(isFinite(b.soi)).toBe(true);
    }
  });
});
