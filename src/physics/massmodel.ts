// Mass distribution and aerodynamic-stability model of the vehicle as a
// stack of parts along the body axis.
//
// - CoM and pitch moment of inertia from part masses and positions; tank
//   propellant settles to the tank bottom under thrust, so the propellant
//   column shortens as it drains and the CoM shifts in flight.
// - Center of pressure via the Barrowman method (J. Barrowman, "The
//   Practical Calculation of the Aerodynamic Characteristics of Slender
//   Finned Vehicles", NASA TIR-33, 1967): per-component normal-force
//   slopes C_Nα and centers, combined as CoP = Σ(C_Nαᵢ·xᵢ)/ΣC_Nαᵢ.
//   Static margin (calibers) = (y_CoM − y_CoP)/d_ref; positive (CoP aft
//   of CoM) is stable.
//
// All coordinates are stack coordinates: y up, 0 at the bottom of the
// fully assembled vehicle, in meters.

export interface GeomPart {
  /** Craft part id (events, UI highlights). */
  partId: string;
  name: string;
  /** Burn-order stage this part belongs to (detached with that stage). */
  stage: number;
  y: number; // bottom of part [m]
  height: number;
  radius: number; // representative radius [m]
  /** In-plane lateral offset of this part's instances from the axis [m]
   * (0 for stack parts; ring radius for radial groups). */
  lateral: number;
  dryMass: number; // total across all instances [kg]
  propellant: number; // total tank propellant at full load [kg]
  /** Barrowman normal-force slope contribution (referenced to refArea). */
  cnAlpha: number;
  /** Stack-coordinate y of that contribution's center of pressure. */
  yCp: number;
  /** Structural dynamic-pressure limit [Pa]. */
  maxQ: number;
  /** Structural Mach limit — scalar stand-in for aerothermal/flutter
   * limits (NOT a thermal model). Checked only at meaningful q. */
  maxMach?: number;
  /** Aero surface that can tear off without destroying the vehicle. */
  shedable: boolean;
}

export interface LegInfo {
  partId: string;
  stage: number;
  /** Footprint radius from the vehicle axis when deployed [m]. */
  footprint: number;
}

export interface ChuteInfo {
  partId: string;
  stage: number;
  /** Deployed drag area Cd·A [m²]. */
  cdA: number;
  /** Safe-deploy dynamic pressure [Pa]; deploying above tears the canopy. */
  safeQ: number;
  /** Stack height where the riser pulls (canopy force application) [m]. */
  y: number;
}

export interface VehicleGeometry {
  parts: GeomPart[];
  refDiameter: number; // Barrowman reference diameter [m]
  refArea: number; // π d²/4 [m²]
  length: number; // full-stack length [m]
  legs: LegInfo[];
  chutes: ChuteInfo[];
  /** Jettisonable payload fairings (deploy mechanism). */
  fairings?: { partId: string; mass: number }[];
}

export interface MassProperties {
  mass: number; // [kg]
  yCoM: number; // [m, stack coords]
  /** Pitch moment of inertia about the CoM [kg·m²]. */
  inertia: number;
  /** Total normal-force slope ΣC_Nα (0 if no aero surfaces attached). */
  cnAlpha: number;
  yCoP: number; // [m] (NaN when cnAlpha = 0)
  /** Σ C_Nαᵢ·(yᵢ−y_CoM)² — the pitch-damping sum [m²]. */
  dampingSum: number;
  /** Static margin in calibers; positive = stable. */
  staticMarginCal: number;
}

/**
 * Mass properties of the currently attached assembly.
 * @param stageIndex stages < stageIndex are gone
 * @param propFraction remaining propellant fraction of the CURRENT stage,
 *   or a per-stage array of fill fractions (crossfeed drains other
 *   sections' tanks, so fills are not a single scalar).
 * @param torn part ids shed by aerodynamic failure
 */
export function massProperties(
  geom: VehicleGeometry,
  stageIndex: number,
  propFraction: number | number[],
  torn?: ReadonlySet<string>,
): MassProperties {
  let m = 0;
  let my = 0;
  const items: { m: number; y: number; h: number; r: number; lat: number }[] = [];

  for (const p of geom.parts) {
    if (p.stage < stageIndex || torn?.has(p.partId)) continue;
    // Dry structure: centroid at the part's geometric center.
    items.push({ m: p.dryMass, y: p.y + p.height / 2, h: p.height, r: p.radius, lat: p.lateral });
    if (p.propellant > 0) {
      const f = Array.isArray(propFraction)
        ? (propFraction[p.stage] ?? 1)
        : p.stage === stageIndex
          ? propFraction
          : 1;
      if (f > 0) {
        // Propellant settles: a column of height f·h starting at the tank
        // bottom, centroid at f·h/2.
        const hCol = f * p.height;
        items.push({ m: p.propellant * f, y: p.y + hCol / 2, h: hCol, r: p.radius, lat: p.lateral });
      }
    }
  }
  for (const it of items) {
    m += it.m;
    my += it.m * it.y;
  }
  const yCoM = m > 0 ? my / m : 0;

  // Pitch inertia: each item as a solid cylinder about its own center,
  // I = m(3r² + h²)/12, plus parallel-axis md². Radial rings displaced
  // laterally add m·lat²/2 (in-plane average around the ring).
  let inertia = 0;
  for (const it of items) {
    const d = it.y - yCoM;
    inertia += (it.m * (3 * it.r * it.r + it.h * it.h)) / 12 + it.m * (d * d + (it.lat * it.lat) / 2);
  }

  let cn = 0;
  let cnY = 0;
  let damp = 0;
  for (const p of geom.parts) {
    if (p.stage < stageIndex || torn?.has(p.partId) || p.cnAlpha === 0) continue;
    cn += p.cnAlpha;
    cnY += p.cnAlpha * p.yCp;
    damp += p.cnAlpha * (p.yCp - yCoM) * (p.yCp - yCoM);
  }
  const yCoP = cn > 0 ? cnY / cn : NaN;

  return {
    mass: m,
    yCoM,
    inertia: Math.max(inertia, 1), // never zero — a bare probe still has size
    cnAlpha: cn,
    yCoP,
    dampingSum: damp,
    staticMarginCal: cn > 0 ? (yCoM - yCoP) / geom.refDiameter : 0,
  };
}

// ---------- Barrowman component formulas (TIR-33) ----------

/** Nose cone: C_Nα = 2 (per radian, referenced to its own base area),
 * scaled to the reference area. xCp measured from the nose TIP downward:
 * conical 2/3·L. Returns contribution + CoP as distance from tip. */
export function noseCone(dBase: number, length: number, dRef: number): { cn: number; xFromTip: number } {
  return { cn: 2 * (dBase / dRef) ** 2, xFromTip: (2 / 3) * length };
}

/** Conical transition (shoulder/boat-tail) between diameters d1 (fore) and
 * d2 (aft): C_Nα = 2[(d2/dRef)² − (d1/dRef)²]; xCp from the transition's
 * fore end. */
export function transition(
  d1: number,
  d2: number,
  length: number,
  dRef: number,
): { cn: number; xFromFore: number } {
  const cn = 2 * ((d2 / dRef) ** 2 - (d1 / dRef) ** 2);
  const ratio = d1 / d2;
  const xFromFore =
    (length / 3) * (1 + (1 - ratio) / (1 - ratio * ratio || 1e-9));
  return { cn, xFromFore };
}

/** Trapezoidal fin set: n fins, root chord cr, tip chord ct, span s (one
 * fin, root to tip), sweep = axial distance from root LE to tip LE,
 * mounted on a body of radius rBody. Includes the body-interference
 * factor K = 1 + rBody/(s + rBody). xCp from the fin root leading edge. */
export function finSet(
  n: number,
  cr: number,
  ct: number,
  span: number,
  sweep: number,
  rBody: number,
  dRef: number,
): { cn: number; xFromRootLE: number } {
  // Mid-chord line length.
  const lm = Math.hypot(span, sweep + ct / 2 - cr / 2);
  const cnBare =
    (4 * n * (span / dRef) ** 2) / (1 + Math.sqrt(1 + ((2 * lm) / (cr + ct)) ** 2));
  const K = 1 + rBody / (span + rBody);
  const xFromRootLE =
    (sweep / 3) * ((cr + 2 * ct) / (cr + ct)) +
    (1 / 6) * (cr + ct - (cr * ct) / (cr + ct));
  return { cn: cnBare * K, xFromRootLE };
}

export interface PlaneStability {
  /** Neutral point height in stack coordinates [m]. */
  yNP: number;
  /** Static margin as % of the main wing's MAC; positive = NP aft of
   * CoM = stable. The plane-class analogue of caliber margin — never
   * show a plane calibers, never show a rocket %MAC. */
  staticMarginPctMAC: number;
}

/**
 * Plane-class neutral point: the same Σ(slope·area·position)/Σ(slope·area)
 * aggregation as Barrowman, extended with the finite-wing surfaces. Wing
 * a·S and body C_Nα·refArea share units [m²/rad], so they compose
 * directly; tail surfaces respond to α through their (1 − dε/dα)
 * downwash factor (Nelson §2.3 — the classic neutral-point sum).
 */
export function planeStability(
  props: MassProperties,
  refArea: number,
  aero: import('./vehicle').PlaneAero,
): PlaneStability {
  let W = props.cnAlpha > 0 ? props.cnAlpha * refArea : 0;
  let Wy = props.cnAlpha > 0 ? props.cnAlpha * refArea * props.yCoP : 0;
  for (const s of aero.surfaces) {
    const aEff = s.a * (s.downwash ?? 1);
    W += aEff * s.S;
    Wy += aEff * s.S * s.y;
  }
  const yNP = W > 0 ? Wy / W : NaN;
  return {
    yNP,
    staticMarginPctMAC: W > 0 ? (100 * (props.yCoM - yNP)) / aero.mac : NaN,
  };
}

/**
 * Fallback geometry for vehicles built directly from Stage[] data (tests,
 * hand-rolled vehicles): stages stacked as cylinders sized from propellant
 * volume at kerolox bulk density, engines as short cylinders, a nose cone
 * on top. Crude but mass-consistent.
 */
import { Stage, stageDryMass, stagePropellant } from './vehicle';

export function synthesizeGeometry(stages: Stage[], payloadMass: number, radius = 1.85): VehicleGeometry {
  const parts: GeomPart[] = [];
  let y = 0;
  const dRef = 2 * radius;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    const engineH = 2.5;
    parts.push({
      partId: `syn-eng-${i}`,
      name: 'engines',
      stage: i,
      y,
      height: engineH,
      radius: radius * 0.6,
      lateral: 0,
      dryMass: s.engines.reduce((sum, g) => sum + g.engine.mass * g.count, 0) + (s.extraDryMass ?? 0),
      propellant: 0,
      cnAlpha: 0,
      yCp: 0,
      maxQ: 120_000,
      shedable: false,
    });
    y += engineH;
    const prop = stagePropellant(s);
    const tankH = Math.max(2, prop / 1030 / (Math.PI * radius * radius));
    parts.push({
      partId: `syn-tank-${i}`,
      name: 'tank',
      stage: i,
      y,
      height: tankH,
      radius,
      lateral: 0,
      dryMass: stageDryMass(s) - parts[parts.length - 1]!.dryMass,
      propellant: prop,
      cnAlpha: 0,
      yCp: 0,
      maxQ: 120_000,
      shedable: false,
    });
    y += tankH;
  }
  const noseH = 3;
  const lastStage = Math.max(0, stages.length - 1);
  const nose = noseCone(dRef, noseH, dRef);
  parts.push({
    partId: 'syn-nose',
    name: 'payload',
    stage: lastStage,
    y,
    height: noseH,
    radius,
    lateral: 0,
    dryMass: Math.max(payloadMass, 1),
    propellant: 0,
    cnAlpha: nose.cn,
    yCp: y + noseH - nose.xFromTip,
    maxQ: 200_000,
    shedable: false,
  });
  y += noseH;
  return { parts, refDiameter: dRef, refArea: Math.PI * radius * radius, length: y, legs: [], chutes: [] };
}
