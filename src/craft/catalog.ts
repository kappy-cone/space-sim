// VAB part catalog: geometry (stacked frustum segments, origin at bottom
// center, axis vertical) plus physics hookup. Engine performance comes from
// the sourced roster in physics/parts.ts; geometric dimensions are visual
// approximations of the real engines (physics never reads them). Tank
// propellant loads follow from geometry: V·ρ_bulk·fill with kerolox bulk
// density ≈ 1030 kg/m³ (LOX/RP-1 at O/F ≈ 2.3) and 95% usable fill; tank
// structure ≈ 4.5% of propellant (see physics/parts.ts for the basis).
// Decoupler and fairing masses are ESTIMATES typical of flown adapters.

import { Segment } from '../gl/mesh';

export type PartKind = 'payload' | 'tank' | 'engine' | 'decoupler' | 'nose' | 'fin' | 'leg' | 'chute';

/** Trapezoidal fin planform [m]: root chord, tip chord, span, leading-edge
 * sweep (root LE → tip LE, toward the tail), plate thickness. */
export interface FinShape {
  cr: number;
  ct: number;
  span: number;
  sweep: number;
  thickness: number;
}

export interface PartDef {
  id: string;
  name: string;
  kind: PartKind;
  segments: Segment[];
  height: number;
  radiusBottom: number;
  radiusTop: number;
  maxRadius: number;
  color: [number, number, number];
  dryMass: number; // kg (engines: informational — physics uses the roster)
  propellant?: number; // kg, tanks only
  engineId?: string; // physics/parts.ts roster id, engines only
  stackTop: boolean; // something can sit on top of me
  stackBottom: boolean; // something can hang below me
  radialParent: boolean; // parts may attach to my side
  radialChild: boolean; // I may attach to a side
  clusterable?: boolean; // engines: symmetry key sets cluster count
  /** Fin planform; when set, render/pick as a fin and mount flush on the
   * parent surface instead of standing off by maxRadius. */
  fin?: FinShape;
  /** Reaction-control torque authority [N·m] this part contributes
   * (cold-gas RCS class — Draco-couple order of magnitude; estimates). */
  rcsTorque?: number;
  /** Landing leg: reach [m] outward+down from the mount when deployed.
   * Footprint radius ≈ parent radius + reach·sin(deploy angle). */
  leg?: { reach: number };
  /** Parachute: deployed drag area Cd·A [m²] and the safe-deploy dynamic
   * pressure envelope [Pa] — deploy above it and the canopy tears. */
  chute?: { cdA: number; safeQ: number };
}

const cyl = (r: number, h: number, y0 = 0): Segment => ({ y0, y1: y0 + h, r0: r, r1: r });
const fru = (r0: number, r1: number, h: number, y0 = 0): Segment => ({ y0, y1: y0 + h, r0, r1 });

function def(d: Omit<PartDef, 'height' | 'radiusBottom' | 'radiusTop' | 'maxRadius'>): PartDef {
  const segs = d.segments;
  const height = segs[segs.length - 1]!.y1;
  return {
    ...d,
    height,
    radiusBottom: segs[0]!.r0,
    radiusTop: segs[segs.length - 1]!.r1,
    maxRadius: Math.max(...segs.flatMap((s) => [s.r0, s.r1])),
  };
}

// Tank propellant from geometry: π r² h · 1030 kg/m³ · 0.95, rounded.
const tankProp = (r: number, h: number): number => Math.round(Math.PI * r * r * h * 1030 * 0.95);

function tank(id: string, name: string, r: number, h: number, tint: number): PartDef {
  const prop = tankProp(r, h);
  return def({
    id,
    name,
    kind: 'tank',
    segments: [cyl(r, h)],
    color: [0.78 + tint, 0.8 + tint, 0.84 + tint],
    dryMass: Math.round(prop * 0.045),
    propellant: prop,
    stackTop: true,
    stackBottom: true,
    radialParent: true,
    radialChild: true,
  });
}

export const PARTS: readonly PartDef[] = [
  // ---- payloads (masses are the player's cargo, not physics claims) ----
  def({
    id: 'probe',
    name: 'Probe Core (1 t)',
    kind: 'payload',
    segments: [cyl(0.6, 0.9)],
    color: [0.85, 0.72, 0.35],
    dryMass: 1_000,
    stackTop: false,
    stackBottom: true,
    radialParent: true,
    radialChild: false,
    rcsTorque: 100, // small cold-gas set
  }),
  def({
    id: 'capsule',
    name: 'Crew Capsule (4.2 t)',
    kind: 'payload',
    segments: [fru(1.85, 0.95, 2.4)],
    color: [0.88, 0.88, 0.9],
    dryMass: 4_200,
    stackTop: false,
    stackBottom: true,
    radialParent: true, // chutes/legs mount on the capsule side
    radialChild: false,
    rcsTorque: 1_600, // ~Draco-class couple: 2 × 400 N × 2 m (estimate)
  }),
  def({
    id: 'station-module',
    name: 'Station Module (10 t)',
    kind: 'payload',
    segments: [cyl(1.85, 3.2)],
    color: [0.75, 0.78, 0.85],
    dryMass: 10_000,
    stackTop: false,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    rcsTorque: 800,
  }),
  // ---- tanks ----
  tank('t12-s', 'Tank 1.2 m short', 0.6, 1.8, 0.0),
  tank('t12-m', 'Tank 1.2 m', 0.6, 3.6, 0.02),
  tank('t24-s', 'Tank 2.4 m short', 1.2, 3.5, 0.0),
  tank('t24-m', 'Tank 2.4 m', 1.2, 7, 0.02),
  tank('t37-m', 'Tank 3.7 m', 1.85, 8, 0.0),
  tank('t37-l', 'Tank 3.7 m long', 1.85, 16, 0.02),
  tank('t37-xl', 'Tank 3.7 m XL', 1.85, 24, 0.04),
  // ---- engines (perf from physics/parts.ts; shapes approximate) ----
  def({
    id: 'e-merlin-1d',
    name: 'Merlin 1D',
    kind: 'engine',
    segments: [fru(0.46, 0.2, 1.5), cyl(0.35, 0.7, 1.5)],
    color: [0.45, 0.47, 0.52],
    dryMass: 470,
    engineId: 'merlin-1d',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    clusterable: true,
  }),
  def({
    id: 'e-merlin-vac',
    name: 'Merlin 1D Vacuum',
    kind: 'engine',
    segments: [fru(1.55, 0.35, 3.2), cyl(0.4, 0.8, 3.2)],
    color: [0.5, 0.42, 0.38],
    dryMass: 600,
    engineId: 'merlin-vac',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'e-rs25',
    name: 'RS-25',
    kind: 'engine',
    segments: [fru(1.15, 0.3, 3.2), cyl(0.55, 1.0, 3.2)],
    color: [0.55, 0.55, 0.6],
    dryMass: 3_527,
    engineId: 'rs-25',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    clusterable: true,
  }),
  def({
    id: 'e-raptor-2',
    name: 'Raptor 2',
    kind: 'engine',
    segments: [fru(0.65, 0.25, 2.2), cyl(0.5, 0.9, 2.2)],
    color: [0.5, 0.5, 0.55],
    dryMass: 1_630,
    engineId: 'raptor-2',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    clusterable: true,
  }),
  def({
    id: 'e-rl10b2',
    name: 'RL10B-2',
    kind: 'engine',
    segments: [fru(1.05, 0.25, 2.9), cyl(0.4, 0.8, 2.9)],
    color: [0.6, 0.58, 0.5],
    dryMass: 301,
    engineId: 'rl10b-2',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'e-rutherford',
    name: 'Rutherford',
    kind: 'engine',
    segments: [fru(0.2, 0.08, 0.5), cyl(0.16, 0.25, 0.5)],
    color: [0.3, 0.32, 0.38],
    dryMass: 35,
    engineId: 'rutherford',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    clusterable: true,
  }),
  // ---- staging (masses: typical adapter/interstage estimates) ----
  def({
    id: 'dec-12',
    name: 'Decoupler 1.2 m',
    kind: 'decoupler',
    segments: [cyl(0.62, 0.25)],
    color: [0.75, 0.6, 0.3],
    dryMass: 40,
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'dec-24',
    name: 'Decoupler 2.4 m',
    kind: 'decoupler',
    segments: [cyl(1.22, 0.3)],
    color: [0.75, 0.6, 0.3],
    dryMass: 120,
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'dec-37',
    name: 'Decoupler 3.7 m',
    kind: 'decoupler',
    segments: [cyl(1.87, 0.35)],
    color: [0.75, 0.6, 0.3],
    dryMass: 300,
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  // ---- nose cones (fairing-class masses; estimates) ----
  def({
    id: 'nose-12',
    name: 'Nose Cone 1.2 m',
    kind: 'nose',
    segments: [fru(0.6, 0.05, 1.6)],
    color: [0.85, 0.85, 0.88],
    dryMass: 80,
    stackTop: false,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'nose-24',
    name: 'Nose Cone 2.4 m',
    kind: 'nose',
    segments: [fru(1.2, 0.08, 2.8)],
    color: [0.85, 0.85, 0.88],
    dryMass: 300,
    stackTop: false,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  // ---- landing gear & recovery ----
  def({
    id: 'leg-s',
    name: 'Landing Leg S',
    kind: 'leg',
    // Pick/render proxy: slim strut along the hull; deployed pose is
    // drawn splayed in the flight view.
    segments: [cyl(0.12, 1.6)],
    color: [0.35, 0.37, 0.42],
    // F9-class legs are ~600 kg each at 10× this vehicle scale; small
    // strut estimate:
    dryMass: 120,
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    leg: { reach: 2.2 },
  }),
  def({
    id: 'leg-l',
    name: 'Landing Leg L',
    kind: 'leg',
    segments: [cyl(0.2, 3.2)],
    color: [0.35, 0.37, 0.42],
    dryMass: 450, // Falcon-9 leg class (~600 kg each incl. mechanisms, est.)
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    leg: { reach: 4.5 },
  }),
  def({
    id: 'chute-main',
    name: 'Parachute',
    kind: 'chute',
    segments: [cyl(0.35, 0.5)],
    color: [0.85, 0.45, 0.25],
    dryMass: 90, // main-canopy class for a capsule (estimate)
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    // Crew-Dragon-class main cluster equivalent (4×27 m canopies ≈
    // 1400 m² CdA) → ~7 m/s at 4.3 t. Safe deploy below ~2.5 kPa.
    chute: { cdA: 1_400, safeQ: 2_500 },
  }),
  def({
    id: 'chute-drogue',
    name: 'Drogue Chute',
    kind: 'chute',
    segments: [cyl(0.25, 0.4)],
    color: [0.8, 0.6, 0.3],
    dryMass: 35,
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    // Small stabilizing canopy, tougher envelope.
    chute: { cdA: 25, safeQ: 12_000 },
  }),
  // ---- fins (aluminum-plate mass estimate: planform area × t × 2700) ----
  finDef('fin-s', 'Fin S', { cr: 0.8, ct: 0.4, span: 0.55, sweep: 0.3, thickness: 0.012 }),
  finDef('fin-m', 'Fin M', { cr: 1.6, ct: 0.8, span: 1.1, sweep: 0.6, thickness: 0.02 }),
  finDef('fin-l', 'Fin L', { cr: 2.6, ct: 1.3, span: 1.7, sweep: 1.0, thickness: 0.03 }),
];

function finDef(id: string, name: string, fin: FinShape): PartDef {
  const area = ((fin.cr + fin.ct) / 2) * fin.span;
  return def({
    id,
    name,
    kind: 'fin',
    // Pick-proxy cylinder spanning the root chord (real shape is the fin
    // mesh; picking treats it as a thin drum around the mount point).
    segments: [cyl(fin.span * 0.5, fin.cr)],
    color: [0.62, 0.66, 0.74],
    dryMass: Math.round(area * fin.thickness * 2700),
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    fin,
  });
}

export const partById = (id: string): PartDef => {
  const p = PARTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown part: ${id}`);
  return p;
};

/** Radius of a part's side surface at part-local height y. */
export function radiusAt(defn: PartDef, y: number): number {
  for (const s of defn.segments) {
    if (y >= s.y0 && y <= s.y1) {
      const f = (y - s.y0) / (s.y1 - s.y0 || 1);
      return s.r0 + (s.r1 - s.r0) * f;
    }
  }
  return defn.maxRadius;
}
