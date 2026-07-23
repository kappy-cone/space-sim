// VAB part catalog: geometry (stacked frustum segments, origin at bottom
// center, axis vertical) plus physics hookup. Engine performance comes from
// the sourced roster in physics/parts.ts; geometric dimensions are visual
// approximations of the real hardware (physics never reads them).
//
// Tanks are PARAMETRIC: the discrete axes are fluid × diameter, and length
// is a build-time parameter (CraftPart.length) within lengthRange. The
// propellant load follows from geometry: V·ρ_fluid·0.95 usable fill, and
// tank structure scales with VOLUME (35 kg/m³ — see physics/propellants.ts)
// so the density tradeoff between fluids is real.
//
// Every part carries a `source`; the roster validator rejects parts
// without one. Estimates are flagged in the source string itself.

import { Segment } from '../gl/mesh';
import { PropellantId } from '../physics/propellants';

export type PartKind =
  | 'payload'
  | 'tank'
  | 'engine'
  | 'decoupler'
  | 'adapter'
  | 'nose'
  | 'fin'
  | 'leg'
  | 'chute'
  | 'control';

/** Trapezoidal fin planform [m]: root chord, tip chord, span, leading-edge
 * sweep (root LE → tip LE, toward the tail), plate thickness. */
export interface FinShape {
  cr: number;
  ct: number;
  span: number;
  sweep: number;
  thickness: number;
}

/** Generic deploy state: one mechanism for fairings, nozzle extensions,
 * and future deployables — state + mass delta + reversible flag; the
 * `effect` keys the system that reads it. */
export interface DeployDef {
  label: string;
  reversible: boolean;
  /** Mass change on deploy [kg] (jettisoned fairing shells: −dryMass). */
  massDelta: number;
  effect: 'nozzle' | 'fairing' | 'legs' | 'chutes';
}

export interface ControlDef {
  /** RCS translation thrust usable for ullage settling [N]. */
  rcsThrust?: number;
  /** RCS torque contribution [N·m]. */
  rcsTorque?: number;
  /** Self-contained RCS propellant budget [kg]. */
  rcsPropellant?: number;
  /** CMG/reaction-wheel torque [N·m] — free but saturates. */
  wheelTorque?: number;
  /** Momentum capacity before saturation [N·m·s]. */
  wheelCapacity?: number;
  /** Fin is an ACTIVE control surface (torque scales with q). */
  finControl?: boolean;
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
  /** Machine-checked citation — the validator rejects unsourced parts. */
  source: string;
  propellant?: number; // kg, fixed loads (solids); tanks compute from geometry
  /** Tank fluid; propellant mass = π r² · length · 0.95 · ρ_fluid. */
  fluid?: PropellantId;
  /** Parametric length range [m]; length is a per-part build parameter. */
  lengthRange?: { min: number; max: number };
  engineId?: string; // physics/parts.ts roster id, liquid engines
  /** Integrated solid motor (motor + casing in one part): roster id. */
  solidMotor?: string;
  /** Nose pressure-drag class when this part leads the airstream
   * (Hoerner, Fluid-Dynamic Drag ch. 3 — approximate class values). */
  noseCd?: number;
  /** Payload fairing: encloses parts within the cavity from the drag
   * model until jettisoned. */
  fairing?: { innerRadius: number; innerHeight: number };
  /** Decoupler/pylon passes propellant (crossfeed). */
  crossfeed?: boolean;
  /** Dedicated ullage motor: fired to settle propellant, not propulsion. */
  ullage?: boolean;
  deploy?: DeployDef;
  control?: ControlDef;
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
  /** Landing leg: reach [m] outward+down from the mount when deployed. */
  leg?: { reach: number };
  /** Parachute: deployed drag area Cd·A [m²] and safe-deploy q [Pa]. */
  chute?: { cdA: number; safeQ: number };
  /** Hidden from the palette (legacy aliases kept for saved crafts). */
  hidden?: boolean;
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

const TANK_SOURCE =
  'Volume-parametric; ρ from physics/propellants.ts (Sutton), structure 35 kg/m³ (F9 S2 + S-IVB derived)';

const FLUID_TINT: Record<string, [number, number, number]> = {
  kerolox: [0.8, 0.8, 0.84],
  hydrolox: [0.86, 0.88, 0.95],
  methalox: [0.78, 0.83, 0.82],
  hypergolic: [0.82, 0.78, 0.7],
};

function tank(id: string, name: string, fluid: PropellantId, r: number, h: number, range: { min: number; max: number }, hidden = false): PartDef {
  return def({
    id,
    name,
    kind: 'tank',
    segments: [cyl(r, h)],
    color: FLUID_TINT[fluid] ?? [0.8, 0.8, 0.84],
    dryMass: 0, // computed from volume at compile time
    fluid,
    lengthRange: range,
    source: TANK_SOURCE,
    stackTop: true,
    stackBottom: true,
    radialParent: true,
    radialChild: true,
    hidden,
  });
}

function engine(
  id: string,
  name: string,
  engineId: string,
  segments: Segment[],
  color: [number, number, number],
  dryMass: number,
  source: string,
  clusterable = false,
): PartDef {
  return def({
    id,
    name,
    kind: 'engine',
    segments,
    color,
    dryMass,
    engineId,
    source,
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    clusterable,
  });
}

const R12 = { min: 1.0, max: 8 };
const R24 = { min: 1.5, max: 16 };
const R37 = { min: 2.0, max: 26 };

export const PARTS: readonly PartDef[] = [
  // ---- payloads (masses are the player's cargo, not physics claims) ----
  def({
    id: 'probe',
    name: 'Probe Core (1 t)',
    kind: 'payload',
    segments: [cyl(0.6, 0.9)],
    color: [0.85, 0.72, 0.35],
    dryMass: 1_000,
    source: 'Player cargo (declared mass); cold-gas RCS torque/thrust/budget estimates',
    noseCd: 0.65, // flat-faced drum leading the airstream (Hoerner class)
    stackTop: false,
    stackBottom: true,
    radialParent: true,
    radialChild: false,
    rcsTorque: 100,
    control: { rcsThrust: 150, rcsPropellant: 12 },
  }),
  def({
    id: 'capsule',
    name: 'Crew Capsule (4.2 t)',
    kind: 'payload',
    segments: [fru(1.85, 0.95, 2.4)],
    color: [0.88, 0.88, 0.9],
    dryMass: 4_200,
    source: 'Player cargo (declared mass); Draco-class RCS couple/thrust/budget estimates',
    noseCd: 0.35, // rounded frustum nose (Hoerner class)
    stackTop: false,
    stackBottom: true,
    radialParent: true,
    radialChild: false,
    rcsTorque: 1_600,
    control: { rcsThrust: 600, rcsPropellant: 40 },
  }),
  def({
    id: 'station-module',
    name: 'Station Module (10 t)',
    kind: 'payload',
    segments: [cyl(1.85, 3.2)],
    color: [0.75, 0.78, 0.85],
    dryMass: 10_000,
    source: 'Player cargo (declared mass); RCS estimates',
    noseCd: 0.7, // blunt cylinder face
    stackTop: false,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
    rcsTorque: 800,
    control: { rcsThrust: 400, rcsPropellant: 30 },
  }),
  // ---- tanks: fluid × diameter, length parametric ----
  tank('t12-m', 'Kerolox Tank 1.2 m', 'kerolox', 0.6, 3.6, R12),
  tank('t24-m', 'Kerolox Tank 2.4 m', 'kerolox', 1.2, 7, R24),
  tank('t37-m', 'Kerolox Tank 3.7 m', 'kerolox', 1.85, 8, R37),
  tank('h12', 'Hydrolox Tank 1.2 m', 'hydrolox', 0.6, 4.5, R12),
  tank('h24', 'Hydrolox Tank 2.4 m', 'hydrolox', 1.2, 9, R24),
  tank('h37', 'Hydrolox Tank 3.7 m', 'hydrolox', 1.85, 12, R37),
  tank('m12', 'Methalox Tank 1.2 m', 'methalox', 0.6, 4, R12),
  tank('m24', 'Methalox Tank 2.4 m', 'methalox', 1.2, 8, R24),
  tank('m37', 'Methalox Tank 3.7 m', 'methalox', 1.85, 10, R37),
  tank('hyp12', 'Hypergolic Tank 1.2 m', 'hypergolic', 0.6, 1.6, R12),
  tank('hyp24', 'Hypergolic Tank 2.4 m', 'hypergolic', 1.2, 2.5, R24),
  // Legacy aliases (saved crafts): kerolox, fixed default lengths.
  tank('t12-s', 'Kerolox Tank 1.2 m (short)', 'kerolox', 0.6, 1.8, R12, true),
  tank('t24-s', 'Kerolox Tank 2.4 m (short)', 'kerolox', 1.2, 3.5, R24, true),
  tank('t37-l', 'Kerolox Tank 3.7 m (long)', 'kerolox', 1.85, 16, R37, true),
  tank('t37-xl', 'Kerolox Tank 3.7 m (XL)', 'kerolox', 1.85, 24, R37, true),
  // ---- liquid engines (perf from physics/parts.ts; shapes approximate) ----
  engine('e-merlin-1d', 'Merlin 1D', 'merlin-1d', [fru(0.46, 0.2, 1.5), cyl(0.35, 0.7, 1.5)], [0.45, 0.47, 0.52], 470, 'Roster: SpaceX (see physics/parts.ts)', true),
  engine('e-merlin-vac', 'Merlin 1D Vacuum', 'merlin-vac', [fru(1.55, 0.35, 3.2), cyl(0.4, 0.8, 3.2)], [0.5, 0.42, 0.38], 600, 'Roster: SpaceX (see physics/parts.ts)'),
  engine('e-rd180', 'RD-180', 'rd-180', [fru(0.95, 0.35, 2.4), cyl(0.62, 1.2, 2.4)], [0.42, 0.4, 0.45], 5_480, 'Roster: P&W/ULA (see physics/parts.ts)'),
  engine('e-rs25', 'RS-25', 'rs-25', [fru(1.15, 0.3, 3.2), cyl(0.55, 1.0, 3.2)], [0.55, 0.55, 0.6], 3_527, 'Roster: L3Harris/NASA (see physics/parts.ts)', true),
  engine('e-raptor-2', 'Raptor 2', 'raptor-2', [fru(0.65, 0.25, 2.2), cyl(0.5, 0.9, 2.2)], [0.5, 0.5, 0.55], 1_630, 'Roster: SpaceX (see physics/parts.ts)', true),
  engine('e-j2', 'J-2', 'j-2', [fru(0.98, 0.3, 2.5), cyl(0.5, 0.9, 2.5)], [0.58, 0.56, 0.52], 1_788, 'Roster: NASA Saturn V (see physics/parts.ts)', true),
  engine('e-rl10b2', 'RL10B-2', 'rl10b-2', [fru(1.05, 0.25, 2.9), cyl(0.4, 0.8, 2.9)], [0.6, 0.58, 0.5], 301, 'Roster: L3Harris/ULA (see physics/parts.ts)'),
  engine('e-aj10', 'AJ10-190 (OMS)', 'aj10-190', [fru(0.55, 0.16, 1.3), cyl(0.22, 0.4, 1.3)], [0.52, 0.5, 0.46], 118, 'Roster: Aerojet/NASA OMS (see physics/parts.ts)', true),
  engine('e-rutherford', 'Rutherford', 'rutherford', [fru(0.2, 0.08, 0.5), cyl(0.16, 0.25, 0.5)], [0.3, 0.32, 0.38], 35, 'Roster: Rocket Lab (see physics/parts.ts)', true),
  // ---- solid boosters (motor + casing integrated; commitment built in) ----
  def({
    id: 'srb-gem40',
    name: 'GEM-40 Solid Booster',
    kind: 'engine',
    segments: [fru(0.55, 0.5, 0.9), cyl(0.5, 10.2, 0.9), fru(0.5, 0.12, 1.6, 11.1)],
    color: [0.9, 0.9, 0.92],
    dryMass: 1_361, // inert — Delta II GEM-40 data
    propellant: 11_766, // cast grain — Delta II GEM-40 data
    source: 'Boeing/NG Delta II GEM-40 (11,766 kg grain, 1,361 kg inert); geometry approximate (1.0 m × 13 m class)',
    solidMotor: 'gem-40',
    stackTop: true,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
  }),
  def({
    id: 'srb-rsrm',
    name: 'RSRM Solid Booster',
    kind: 'engine',
    segments: [fru(1.95, 1.8, 1.4), cyl(1.85, 31.5, 1.4), fru(1.85, 0.45, 4.2, 32.9)],
    color: [0.88, 0.86, 0.82],
    dryMass: 87_300, // inert — NASA RSRM
    propellant: 501_700, // NASA RSRM
    source: 'NASA Space Shuttle RSRM (501.7 t grain, 87.3 t inert, 3.71 m × 38.5 m)',
    solidMotor: 'rsrm',
    stackTop: true,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
  }),
  def({
    id: 'ullage-motor',
    name: 'Ullage Motor (TX-280)',
    kind: 'engine',
    segments: [cyl(0.14, 0.75)],
    color: [0.75, 0.72, 0.6],
    dryMass: 27,
    propellant: 25,
    source: 'NASA Saturn S-II ullage motor class (TX-280, 15.1 kN / 3.87 s); case mass estimate',
    solidMotor: 'tx-280',
    ullage: true,
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
  }),
  // ---- staging: decouplers, radial pylons (crossfeed lives here) ----
  def({
    id: 'dec-12',
    name: 'Decoupler 1.2 m',
    kind: 'decoupler',
    segments: [cyl(0.62, 0.25)],
    color: [0.75, 0.6, 0.3],
    dryMass: 40,
    source: 'Typical flown separation-ring mass — ESTIMATE',
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
    source: 'Typical flown separation-ring mass — ESTIMATE',
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
    source: 'Typical flown separation-ring mass — ESTIMATE',
    stackTop: true,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'pylon',
    name: 'Radial Pylon (separating)',
    kind: 'decoupler',
    segments: [cyl(0.28, 0.9)],
    color: [0.7, 0.55, 0.3],
    dryMass: 150,
    source: 'Strap-on attach/release fitting class (Atlas V SRB attach ~150 kg) — ESTIMATE',
    stackTop: false,
    stackBottom: true, // the booster stack hangs from the pylon
    radialParent: false,
    radialChild: true,
  }),
  def({
    id: 'pylon-duct',
    name: 'Radial Pylon + Fuel Duct',
    kind: 'decoupler',
    segments: [cyl(0.3, 0.9)],
    color: [0.85, 0.65, 0.25],
    dryMass: 190,
    source: 'Pylon estimate + transfer plumbing (~40 kg, NASA TSTO crossfeed study class) — ESTIMATE',
    crossfeed: true, // engines inboard drain the outboard stack first
    stackTop: false,
    stackBottom: true,
    radialParent: false,
    radialChild: true,
  }),
  // ---- adapters (structural, non-separating) ----
  def({
    id: 'adapter-24-12',
    name: 'Adapter 2.4 → 1.2 m',
    kind: 'adapter',
    segments: [fru(1.22, 0.62, 1.1)],
    color: [0.7, 0.72, 0.78],
    dryMass: 120,
    source: 'Flown conical adapter class (Centaur forward adapter ~100–200 kg) — ESTIMATE',
    stackTop: true,
    stackBottom: true,
    radialParent: true,
    radialChild: false,
  }),
  def({
    id: 'adapter-37-24',
    name: 'Adapter 3.7 → 2.4 m',
    kind: 'adapter',
    segments: [fru(1.87, 1.22, 1.6)],
    color: [0.7, 0.72, 0.78],
    dryMass: 400,
    source: 'Flown interstage-adapter class (Atlas V C-adapter ~400 kg) — ESTIMATE',
    stackTop: true,
    stackBottom: true,
    radialParent: true,
    radialChild: false,
  }),
  // ---- noses & fairings ----
  def({
    id: 'nose-12',
    name: 'Nose Cone 1.2 m',
    kind: 'nose',
    segments: [fru(0.6, 0.05, 1.6)],
    color: [0.85, 0.85, 0.88],
    dryMass: 80,
    source: 'Composite nose shell class — ESTIMATE; Cd: cone class (Hoerner ch.3)',
    noseCd: 0.25,
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
    source: 'Composite nose shell class — ESTIMATE; Cd: cone class (Hoerner ch.3)',
    noseCd: 0.25,
    stackTop: false,
    stackBottom: true,
    radialParent: false,
    radialChild: false,
  }),
  def({
    id: 'fairing-24',
    name: 'Payload Fairing 2.4 m',
    kind: 'nose',
    segments: [cyl(1.28, 3.2), fru(1.28, 0.1, 2.0, 3.2)],
    color: [0.9, 0.9, 0.92],
    dryMass: 450,
    source: 'Scaled from F9 fairing (1,750 kg at 5.2 m) by ~area ratio — ESTIMATE; Cd: ogive class (Hoerner)',
    noseCd: 0.12,
    fairing: { innerRadius: 1.22, innerHeight: 4.6 },
    deploy: { label: 'Jettison fairing', reversible: false, massDelta: -450, effect: 'fairing' },
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true, // shell mounts around the stack (centered)
  }),
  def({
    id: 'fairing-37',
    name: 'Payload Fairing 3.7 m',
    kind: 'nose',
    segments: [cyl(1.95, 4.6), fru(1.95, 0.12, 2.9, 4.6)],
    color: [0.9, 0.9, 0.92],
    dryMass: 1_100,
    source: 'Scaled from F9 fairing (1,750 kg at 5.2 m) by ~area ratio — ESTIMATE; Cd: ogive class (Hoerner)',
    noseCd: 0.12,
    fairing: { innerRadius: 1.88, innerHeight: 6.8 },
    deploy: { label: 'Jettison fairing', reversible: false, massDelta: -1_100, effect: 'fairing' },
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
  }),
  // ---- control authority ----
  def({
    id: 'rcs-quad',
    name: 'RCS Quad',
    kind: 'control',
    segments: [cyl(0.16, 0.32)],
    color: [0.4, 0.42, 0.48],
    dryMass: 45,
    source: 'Draco-class quad (4 × 400 N, Isp 300 — SpaceX); block mass, torque arm and 40 kg service budget — ESTIMATES',
    control: { rcsThrust: 1_600, rcsTorque: 500, rcsPropellant: 40 },
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
  }),
  def({
    id: 'cmg',
    name: 'Control Moment Gyro',
    kind: 'control',
    segments: [cyl(0.32, 0.5)],
    color: [0.5, 0.52, 0.6],
    dryMass: 272,
    source: 'ISS DGCMG class: 258 N·m, 4,880 N·m·s (NASA); unit mass ~272 kg (approximate)',
    control: { wheelTorque: 258, wheelCapacity: 4_880 },
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
  }),
  // ---- landing gear & recovery ----
  def({
    id: 'leg-s',
    name: 'Landing Leg S',
    kind: 'leg',
    segments: [cyl(0.12, 1.6)],
    color: [0.35, 0.37, 0.42],
    dryMass: 120,
    source: 'Strut estimate (F9 legs ~600 kg each at 10× scale)',
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    leg: { reach: 2.2 },
    deploy: { label: 'Deploy landing legs', reversible: false, massDelta: 0, effect: 'legs' },
  }),
  def({
    id: 'leg-l',
    name: 'Landing Leg L',
    kind: 'leg',
    segments: [cyl(0.2, 3.2)],
    color: [0.35, 0.37, 0.42],
    dryMass: 450,
    source: 'Falcon-9 leg class (~600 kg each incl. mechanisms — estimate)',
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    leg: { reach: 4.5 },
    deploy: { label: 'Deploy landing legs', reversible: false, massDelta: 0, effect: 'legs' },
  }),
  def({
    id: 'chute-main',
    name: 'Parachute',
    kind: 'chute',
    segments: [cyl(0.35, 0.5)],
    color: [0.85, 0.45, 0.25],
    dryMass: 90,
    source: 'Crew-Dragon-class main cluster equivalent (4×27 m ≈ 1,400 m² CdA); safe-q envelope estimate',
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    chute: { cdA: 1_400, safeQ: 2_500 },
    deploy: { label: 'Deploy parachute', reversible: false, massDelta: 0, effect: 'chutes' },
  }),
  def({
    id: 'chute-drogue',
    name: 'Drogue Chute',
    kind: 'chute',
    segments: [cyl(0.25, 0.4)],
    color: [0.8, 0.6, 0.3],
    dryMass: 35,
    source: 'Drogue-class canopy (estimate); tougher deploy envelope',
    stackTop: false,
    stackBottom: false,
    radialParent: false,
    radialChild: true,
    chute: { cdA: 25, safeQ: 12_000 },
    deploy: { label: 'Deploy parachute', reversible: false, massDelta: 0, effect: 'chutes' },
  }),
  // ---- fins (aluminum-plate mass estimate: planform area × t × 2700) ----
  finDef('fin-s', 'Fin S', { cr: 0.8, ct: 0.4, span: 0.55, sweep: 0.3, thickness: 0.012 }),
  finDef('fin-m', 'Fin M', { cr: 1.6, ct: 0.8, span: 1.1, sweep: 0.6, thickness: 0.02 }),
  finDef('fin-l', 'Fin L', { cr: 2.6, ct: 1.3, span: 1.7, sweep: 1.0, thickness: 0.03 }),
  gridFinDef(),
];

function gridFinDef(): PartDef {
  const base = finDef('grid-fin', 'Grid Fin (active)', { cr: 1.4, ct: 1.4, span: 0.55, sweep: 0, thickness: 0.05 });
  return {
    ...base,
    dryMass: 250,
    source: 'F9 titanium grid fin class — mass ESTIMATE (unpublished); plate-fin aero proxy for the lattice',
    control: { finControl: true },
    color: [0.45, 0.42, 0.38],
  };
}

function finDef(id: string, name: string, fin: FinShape): PartDef {
  const area = ((fin.cr + fin.ct) / 2) * fin.span;
  return def({
    id,
    name,
    kind: 'fin',
    segments: [cyl(fin.span * 0.5, fin.cr)],
    color: [0.62, 0.66, 0.74],
    dryMass: Math.round(area * fin.thickness * 2700),
    source: 'Aluminum plate mass from planform × thickness × 2,700 kg/m³',
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
