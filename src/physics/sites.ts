// Launch/landing sites: surface-fixed angles on a body plus a type, a
// range-safety corridor, and (for the world layer) discoverability.
//
// The planar mapping of launch-site geography, stated once: real site
// latitude constrains reachable INCLINATIONS (minimum inclination = site
// latitude without a plane change). The planar sim has exactly one
// orbital plane, so the surviving degree of freedom is DIRECTION —
// prograde (east) vs retrograde (west) — and the analogue constraint is
// the range-safety corridor: which way a site may fly over open water.
// Retrograde is this sim's sun-synchronous stand-in: real SSO is
// retrograde (i ≈ 98°), flown from high-latitude ranges (Vandenberg,
// 34.7° N, launching over the open Pacific), and it pays the full
// rotation penalty — which the planar sim reproduces exactly
// (±ω·R ≈ 465 m/s at the equator each way). What is dropped: latitude
// itself, plane-change burns, and the J2 precession that makes real SSO
// sun-synchronous.
//
// Discoverable sites are prior art from Kerbal Konstructs / Kerbin Side:
// they exist in the world before the player can use them, are found by
// survey reveal or overflight, and are ACTIVATED by landing a cargo
// aircraft on their runway (the hardware-delivery flight). Real
// analogue for the island field: Ascension Island's Wideawake Field,
// the Eastern Range's mid-Atlantic auxiliary airfield.

export type Corridor = 'east' | 'west' | 'both';

export interface Site {
  id: string;
  body: string;
  name: string;
  /** Surface-fixed angle at t = 0 [rad] (the restAngle0 handle). */
  angle: number;
  type: 'pad' | 'runway';
  /** Runways: touchdown accepted within ±halfLength of the site [m]. */
  halfLength?: number;
  /** Range-safety corridor: permitted downrange direction after liftoff.
   * 'east' = prograde only, 'west' = retrograde only. Runways are 'both'
   * (aircraft turn back; range safety governs orbital ascents). */
  corridor: Corridor;
  /** Present in the world from the start (home complex). Everything else
   * must be discovered (survey/overflight) and then activated (cargo
   * landing on the site's runway). */
  startsDiscovered: boolean;
  /** Pad served by this runway: activating the runway activates the pad
   * (the delivered hardware builds out the complex). */
  activatesPad?: string;
}

const R = 6_378_137; // WGS-84 equatorial radius — angle bookkeeping only

export const SITES: readonly Site[] = [
  {
    // The home pad — Cape Canaveral analogue (28.5° N, eastward over the
    // Atlantic): prograde corridor, rotation bonus in the bank.
    id: 'pad-1',
    body: 'earth',
    name: 'Cape Pad',
    angle: 0,
    type: 'pad',
    corridor: 'east',
    startsDiscovered: true,
  },
  {
    // 12 km upshore of the pad (4 km runway: heavy fast deltas need it —
    // Concorde used 3.6 km fields; ESTIMATE class value).
    id: 'runway-1',
    body: 'earth',
    name: 'Cape Runway 09',
    angle: 12_000 / R,
    type: 'runway',
    halfLength: 2_000,
    corridor: 'both',
    startsDiscovered: true,
  },
  {
    // Mid-ocean island airfield ~3,600 km downrange — Ascension Island /
    // Wideawake Field analogue (the Eastern Range's auxiliary strip).
    // Discoverable: ferry range for the starter transports.
    id: 'isla-field',
    body: 'earth',
    name: 'Wideawake Field',
    angle: 0.565, // ≈ 3,600 km of arc
    type: 'runway',
    halfLength: 2_000,
    corridor: 'both',
    startsDiscovered: false,
  },
  {
    // The retrograde complex — Vandenberg analogue (34.7° N, launching
    // over the open Pacific away from land): west corridor only. Its
    // runway is the delivery field; landing there activates the pad.
    id: 'runway-west',
    body: 'earth',
    name: 'West Range Strip',
    angle: 1.72, // ≈ 11,000 km of arc — beyond single-hop ferry range
    type: 'runway',
    halfLength: 2_000,
    corridor: 'both',
    startsDiscovered: false,
    activatesPad: 'pad-west',
  },
  {
    id: 'pad-west',
    body: 'earth',
    name: 'West Range Pad',
    angle: 1.72 + 15_000 / R, // 15 km up the coast from its strip
    type: 'pad',
    corridor: 'west',
    startsDiscovered: false,
  },
  // Far-side theater — a second complex on the opposite hemisphere
  // (~antipodal to the Cape). Two opposing runways host the air-launch
  // fighter teams for the dogfight (src/combat/); a pad rounds out the
  // base. Discoverable like every other site past the home complex.
  {
    id: 'far-base',
    body: 'earth',
    name: 'Meridian Base (far side)',
    angle: Math.PI,
    type: 'pad',
    corridor: 'both',
    startsDiscovered: false,
  },
  {
    id: 'far-runway-a',
    body: 'earth',
    name: 'Meridian Runway A',
    angle: Math.PI - 11_000 / R, // opposing strips ~22 km apart flank the base
    type: 'runway',
    halfLength: 2_000,
    corridor: 'both',
    startsDiscovered: false,
  },
  {
    id: 'far-runway-b',
    body: 'earth',
    name: 'Meridian Runway B',
    angle: Math.PI + 11_000 / R,
    type: 'runway',
    halfLength: 2_000,
    corridor: 'both',
    startsDiscovered: false,
  },
];

export const siteById = (id: string): Site => {
  const s = SITES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown site: ${id}`);
  return s;
};

/** Default start site per vehicle class. */
export const defaultSite = (plane: boolean): Site => siteById(plane ? 'runway-1' : 'pad-1');
