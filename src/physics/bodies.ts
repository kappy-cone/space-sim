// Celestial bodies, data-driven. Exactly one row today (Earth), but all
// orbital state in the sim is expressed relative to a *named* body so that
// adding a moon later is a table row + patched-conic SOI handoff, not a
// refactor. SOI radius is the Laplace sphere a·(m/M)^(2/5); for the root
// body (no parent) it is effectively infinite.

import { MU_EARTH, OMEGA_EARTH, R_EARTH } from './constants';
import { density as earthDensity, pressure as earthPressure } from './atmosphere';

export interface CelestialBody {
  id: string;
  name: string;
  /** Gravitational parameter GM [m³/s²]. */
  mu: number;
  /** Mean/equatorial surface radius [m] — the altitude datum. */
  radius: number;
  /** Sidereal rotation rate [rad/s] (for surface velocity & co-rotating atmosphere). */
  rotationRate: number;
  /** Sphere-of-influence radius [m] (Laplace: a·(m/M)^(2/5)); Infinity for the root. */
  soi: number;
  /** Parent body id, null for the root of the system. */
  parent: string | null;
  /** Orbital elements about the parent (patched conics later): semi-major
   * axis [m] and phase at t=0 [rad], both in the shared orbital plane.
   * Null for the root body. */
  orbit: { a: number; phase0: number } | null;
  /** Atmosphere model, if the body has one. Altitude above `radius` [m]. */
  atmosphere: { density(h: number): number; pressure(h: number): number; topAltitude: number } | null;
}

export const BODIES: readonly CelestialBody[] = [
  {
    id: 'earth',
    name: 'Earth',
    mu: MU_EARTH, // IERS 2010 — see constants.ts
    radius: R_EARTH, // WGS-84 equatorial
    rotationRate: OMEGA_EARTH, // IERS
    soi: Infinity,
    parent: null,
    orbit: null,
    atmosphere: { density: earthDensity, pressure: earthPressure, topAltitude: 140_000 },
  },
  {
    // SCAFFOLDING: the moon exists in the table and is rendered on its
    // real orbit, but patched-conic SOI transitions are not implemented
    // yet — gravity is still single-body (the current reference body).
    id: 'moon',
    name: 'Moon',
    mu: 4.9048695e12, // GM from JPL DE430 (Folkner et al. 2014)
    radius: 1_737_400, // IAU mean radius
    rotationRate: 2.6617e-6, // tidally locked: 2π / 27.322 d sidereal
    soi: 66_200_000, // Laplace sphere a·(m/M)^(2/5) ≈ 66,200 km
    parent: 'earth',
    // Mean distance 384,400 km, coplanar with everything else (the planar
    // 3-DOF decision holds — see the project brief).
    orbit: { a: 384_400_000, phase0: 1.0 },
    atmosphere: null,
  },
];

/** Laplace sphere-of-influence radius: a·(m/M)^(2/5). */
export function laplaceSoi(a: number, muBody: number, muParent: number): number {
  return a * Math.pow(muBody / muParent, 2 / 5);
}

/**
 * SCAFFOLDING for patched conics: which body's SOI contains a point at
 * distance `r` from `primary`'s center toward a child at distance `d`?
 * Full transitions (state re-referencing at the boundary) are future work;
 * the sim does not call this yet.
 */
export function soiContains(body: CelestialBody, distanceFromBody: number): boolean {
  return distanceFromBody < body.soi;
}

export function bodyById(id: string): CelestialBody {
  const b = BODIES.find((x) => x.id === id);
  if (!b) throw new Error(`unknown body: ${id}`);
  return b;
}

export const EARTH = bodyById('earth');
