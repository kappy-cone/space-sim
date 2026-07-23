// Launch/landing sites: the minimal site concept — a surface-fixed angle
// on a body plus a type. Pads host vertical launches (the original
// hardcoded behavior: angle 0); runways host the plane class's rolling
// takeoffs and landings, with a half-length window for touchdown
// adjudication. Deliberately NOT a mission/unlock system.

export interface Site {
  id: string;
  body: string;
  name: string;
  /** Surface-fixed angle at t = 0 [rad] (the restAngle0 handle). */
  angle: number;
  type: 'pad' | 'runway';
  /** Runways: touchdown accepted within ±halfLength of the site [m]. */
  halfLength?: number;
}

export const SITES: readonly Site[] = [
  { id: 'pad-1', body: 'earth', name: 'Launch Pad', angle: 0, type: 'pad' },
  // 12 km upshore of the pad (4 km runway: heavy fast deltas need it —
  // Concorde used 3.6 km fields; ESTIMATE class value).
  { id: 'runway-1', body: 'earth', name: 'Runway 09', angle: 12_000 / 6_378_137, type: 'runway', halfLength: 2_000 },
];

export const siteById = (id: string): Site => {
  const s = SITES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown site: ${id}`);
  return s;
};

/** Default start site per vehicle class. */
export const defaultSite = (plane: boolean): Site => siteById(plane ? 'runway-1' : 'pad-1');
