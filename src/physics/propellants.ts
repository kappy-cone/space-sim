// Propellant registry. Bulk density at flight mixture ratio is the point:
// hydrogen's Isp advantage is partly cancelled by tank volume, dry mass and
// drag — which is why real vehicles mix stages (Saturn V: kerosene below,
// hydrogen above). Densities are computed from component densities at the
// stated mixture ratio: ρ_bulk = (1+MR) / (MR/ρ_ox + 1/ρ_fuel).
//
// Boiloff is one scalar per fluid applied over mission time — deliberately
// NOT a thermal model. It is what closes the roster: hydrolox must lose
// something on long coasts, or hypergolic has no reason to exist.

export type PropellantId = 'kerolox' | 'hydrolox' | 'methalox' | 'hypergolic' | 'solid';

export interface Propellant {
  id: PropellantId;
  name: string;
  /** Bulk density at flight mixture ratio [kg/m³]. */
  bulkDensity: number;
  /** Fraction of the REMAINING load lost per day (0 = storable). */
  boiloffPerDay: number;
  source: string;
}

export const PROPELLANTS: readonly Propellant[] = [
  {
    id: 'kerolox',
    name: 'RP-1 / LOX',
    // ρ_RP1 810, ρ_LOX 1141 (Sutton & Biblarz, Rocket Propulsion Elements,
    // 9th ed., tables 7-1/7-2) at MR 2.56 (Merlin-class) → 1023 kg/m³.
    bulkDensity: 1023,
    // Only the LOX side boils; kerolox stages hold for hours-to-days with
    // insulation. 0.3%/day is an ESTIMATE anchored to F9 upper-stage
    // long-coast mission kits (LOX losses limit multi-hour coasts).
    boiloffPerDay: 0.003,
    source: 'Sutton & Biblarz 9e (densities); boiloff: engineering estimate, flagged',
  },
  {
    id: 'hydrolox',
    name: 'LH2 / LOX',
    // ρ_LH2 71, ρ_LOX 1141 (Sutton) at MR 6.0 (RS-25/RL10 class) → 361 kg/m³.
    bulkDensity: 361,
    // Centaur-class stages without active cooling lose a few % of LH2 per
    // day; 2%/day is the commonly cited planning figure (ULA Centaur
    // long-duration studies, e.g. Kutter et al., AIAA 2005-3462 class).
    boiloffPerDay: 0.02,
    source: 'Sutton & Biblarz 9e (densities); ULA Centaur boiloff studies (~2%/day)',
  },
  {
    id: 'methalox',
    name: 'LCH4 / LOX',
    // ρ_LCH4 422, ρ_LOX 1141 (Sutton/NIST) at MR 3.6 (Raptor class)
    // → 833 kg/m³.
    bulkDensity: 833,
    // Methane boils off far slower than hydrogen (higher boiling point,
    // denser): 0.5%/day is an ESTIMATE between the LOX-only kerolox rate
    // and hydrolox — the medium-duration niche.
    boiloffPerDay: 0.005,
    source: 'Sutton & Biblarz 9e / NIST (densities); boiloff engineering estimate, flagged',
  },
  {
    id: 'hypergolic',
    name: 'NTO / MMH',
    // ρ_NTO 1440, ρ_MMH 880 (Sutton) at MR 1.65 (OMS/AJ10-190) → 1159 kg/m³.
    bulkDensity: 1159,
    boiloffPerDay: 0, // storable for years — the reason it exists
    source: 'Sutton & Biblarz 9e (densities, storability)',
  },
  {
    id: 'solid',
    name: 'APCP (solid)',
    // PBAN/APCP grain density ≈ 1770 kg/m³ (Shuttle RSRM propellant,
    // NASA RSRM references). Cast in the casing — no tanks.
    bulkDensity: 1770,
    boiloffPerDay: 0,
    source: 'NASA RSRM propellant data (~1.77 g/cm³)',
  },
];

export function propellantById(id: PropellantId): Propellant {
  const p = PROPELLANTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown propellant: ${id}`);
  return p;
}

/** Tank structure scales with VOLUME, not propellant mass — otherwise the
 * density tradeoff disappears. 35 kg/m³ is derived from two real stages:
 * F9 S2 kerolox (~3.2–4.4% of prop mass at ρ 1023 → 33–45 kg/m³,
 * spaceflight101 structural estimates) and Saturn S-IVB hydrolox
 * (~9 t structure / 294 m³ → 31 kg/m³, NASA SP-4012). */
export const TANK_STRUCTURE_KG_PER_M3 = 35;
