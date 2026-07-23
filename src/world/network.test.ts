// Ground-network geometry: elevation mask, occlusion, relay chaining,
// the constellation-coverage relations, and the far-side-Moon forcing
// function (a lander behind the Moon is dark without a lunar relay).

import { describe, expect, it } from 'vitest';
import { EARTH, bodyById, bodyOrbitState } from '../physics/bodies';
import { add, scale, vec } from '../physics/vec2';
import {
  ELEVATION_MASK,
  GROUND_STATIONS,
  constellationAltitude,
  coverageHalfAngle,
  earthFrame,
  hasLink,
  losClear,
  occluders,
  stationPos,
  stationSees,
} from './network';

const R = EARTH.radius;
const gs = GROUND_STATIONS[0]!;

describe('station visibility', () => {
  it('sees a satellite overhead, not one below the horizon', () => {
    const s = stationPos(gs, 0); // t=0: station at angle 0 → (R, 0)
    expect(s.x).toBeCloseTo(R, 3);
    expect(stationSees(gs, vec(R + 400_000, 0), 0)).toBe(true); // zenith
    expect(stationSees(gs, vec(-(R + 400_000), 0), 0)).toBe(false); // antipode
  });

  it('enforces the 5° elevation mask', () => {
    // A target on the horizon plane (elevation 0) fails; at 10° it passes.
    const s = stationPos(gs, 0);
    const up = vec(1, 0);
    const horiz = vec(0, 1);
    const at = (elevDeg: number, dist: number) => {
      const e = (elevDeg * Math.PI) / 180;
      return add(s, add(scale(up, dist * Math.sin(e)), scale(horiz, dist * Math.cos(e))));
    };
    expect(stationSees(gs, at(2, 500_000), 0)).toBe(false);
    expect(stationSees(gs, at(10, 500_000), 0)).toBe(true);
    expect(ELEVATION_MASK).toBeCloseTo((5 * Math.PI) / 180, 9);
  });

  it('the station rotates with the planet', () => {
    // Half a sidereal day later the station faces the other way.
    const half = Math.PI / EARTH.rotationRate;
    expect(stationSees(gs, vec(-(R + 400_000), 0), half)).toBe(true);
    expect(stationSees(gs, vec(R + 400_000, 0), half)).toBe(false);
  });
});

describe('line of sight', () => {
  it('the planet blocks a segment between opposite low orbits', () => {
    const a = vec(R + 300_000, 0);
    const b = vec(-(R + 300_000), 0);
    expect(losClear(a, b, occluders(0))).toBe(false);
    // Two high sats on opposite sides DO see each other over the limb.
    const hi = 20_000_000;
    expect(losClear(vec(R + hi, 0), vec(-(R + hi), 0), occluders(0))).toBe(false); // still through the center
    expect(losClear(vec(R + hi, 0), vec(0, R + hi), occluders(0))).toBe(true); // quarter apart: clear
  });

  it('relay chaining: dark targets link through relays, antipodes need a chain', () => {
    const t = 0;
    const lowAt = (deg: number) =>
      scale(vec(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)), R + 300_000);
    // A LEO vessel 120° around the planet: below the station's tangent
    // plane, dark on its own.
    expect(hasLink(lowAt(120), t, []).linked).toBe(false);
    // A high relay at 45° (above the tangent plane: x > R) sees the
    // station AND clears the limb to the 120° target.
    const hi = R + 20_000_000;
    const relay1 = { pos: scale(vec(Math.SQRT1_2, Math.SQRT1_2), hi), name: 'Relay 1' };
    const res = hasLink(lowAt(120), t, [relay1]);
    expect(res.linked).toBe(true);
    expect(res.viaName).toBe('Relay 1');
    // The ANTIPODAL target stays dark through one relay (the segment
    // clips the planet — real geometry) and links through a two-hop
    // chain via a second relay that itself only sees the first.
    expect(hasLink(lowAt(180), t, [relay1]).linked).toBe(false);
    const relay2 = { pos: vec(-hi, 0), name: 'Relay 2' };
    expect(GROUND_STATIONS.some((st) => stationSees(st, relay2.pos, t))).toBe(false);
    expect(hasLink(lowAt(180), t, [relay1, relay2]).linked).toBe(true);
  });

  it('the Moon blocks its own far side — the lunar-relay forcing function', () => {
    const t = 0;
    const moon = bodyById('moon');
    const eph = bodyOrbitState(moon, t).r;
    // A lander on the far side: antipodal to Earth along the Earth–Moon
    // line, 100 km up.
    const away = scale(eph, 1 / Math.hypot(eph.x, eph.y));
    const farSide = add(eph, scale(away, moon.radius + 200_000));
    expect(hasLink(farSide, t, []).linked).toBe(false);
    // A relay in HIGH lunar orbit off to the side clears the limb to
    // both the far side and the Earth (a low lunar relay would graze —
    // real geometry: far-side relays fly high, cf. Queqiao at the
    // Earth–Moon L2 distance class).
    const perp = vec(-away.y, away.x);
    const lunarRelay = { pos: add(eph, scale(perp, moon.radius + 6_000_000)), name: 'Luna Relay' };
    expect(hasLink(farSide, t, [lunarRelay]).linked).toBe(true);
    // earthFrame converts moon-relative coordinates consistently.
    const rel = scale(away, moon.radius + 200_000);
    const cvt = earthFrame('moon', rel, t);
    expect(cvt.x).toBeCloseTo(farSide.x, 6);
  });
});

describe('constellation coverage math', () => {
  it('altitude and count invert each other through the street-of-coverage relation', () => {
    for (const n of [3, 4, 6, 8]) {
      const h = constellationAltitude(n, R);
      expect(h).toBeGreaterThan(0);
      // At that altitude, N satellites exactly tile the circle.
      const lam = coverageHalfAngle(h, R);
      expect(n * lam).toBeGreaterThanOrEqual(Math.PI * 0.999);
      expect((n + 1) * coverageHalfAngle(constellationAltitude(n + 1, R), R)).toBeGreaterThanOrEqual(
        Math.PI * 0.999,
      );
    }
    // More satellites → lower constellation.
    expect(constellationAltitude(6, R)).toBeLessThan(constellationAltitude(4, R));
    // Too few for geometry: no altitude works.
    expect(constellationAltitude(2, R)).toBe(Infinity);
    // Sanity anchor: a 4-sat single-plane ring needs roughly
    // half-an-Earth-radius-class altitude, not LEO (real intuition:
    // continuous single-plane coverage is expensive).
    expect(constellationAltitude(4, R)).toBeGreaterThan(2_000_000);
  });
});
