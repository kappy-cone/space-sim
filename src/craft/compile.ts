// Compile the craft tree into (a) the aggregate Vehicle the physics core
// flies, (b) the part-layout geometry that drives CoM/inertia/CoP, and
// (c) the per-stage report rows + warnings the builder shows live.
//
// Sectioning: each decoupler separates itself and everything hanging from
// it — sections are numbered by decouplers crossed from the root (0 =
// uppermost). Burn order defaults bottom-up; craft.stageOrder reorders.
// Radial pylons are decouplers too: a strap-on booster hung from a pylon
// is its own section, and its phase burns IN PARALLEL with the core —
// the core's engines light with it (sustainer), and crossfeed pylons
// make the core drink the strap-on's tanks first (asparagus staging).
//
// Tanks are volumetric: propellant = π r²·length·0.95·ρ_fluid and the
// structure scales with volume (35 kg/m³) — see physics/propellants.ts.
//
// Drag: per-stage cd and frontal area. cd = 0.15 base (skin + base drag,
// engineering estimate) + the nose pressure-drag class of whatever part
// leads the airstream (Hoerner ch. 3 class values on the parts). Fairings
// ENCLOSE parts inside their cavity: enclosed parts contribute neither
// area nor drag nor normal force until the fairing is jettisoned.
//
// Aerodynamics: Barrowman components (see physics/massmodel.ts) walked
// over the actual part profile. Engine bells sit in separated base flow
// and contribute nothing.

import { engineById } from '../physics/parts';
import { propellantById, PropellantId, TANK_STRUCTURE_KG_PER_M3 } from '../physics/propellants';
import { G0 } from '../physics/constants';
import {
  ChuteInfo,
  LegInfo,
  MassProperties,
  VehicleGeometry,
  GeomPart,
  finSet,
  massProperties,
  transition,
} from '../physics/massmodel';
import {
  BurnGroup,
  EngineGroup,
  PhasePlan,
  PropellantPool,
  Stage,
  StageReport,
  Vehicle,
  stageReport,
  phaseWalkReport,
  totalDeltaV,
} from '../physics/vehicle';
import { partById } from './catalog';
import { Craft, CraftPart, children, instanceCount, placements } from './craft';

export interface FairingInfo {
  partId: string;
  stage: number;
  mass: number;
  encloses: string[];
}

export interface CompiledStage {
  stage: Stage;
  partIds: string[];
  sectionIndex: number;
  /** Strap-on section (hung from a radial pylon): burns in parallel with
   * the sustainer core. */
  strapOn: boolean;
  crossfeed: boolean;
}

export interface Compiled {
  vehicle: Vehicle;
  stages: CompiledStage[]; // burn order (index 0 burns first)
  reports: StageReport[];
  totalDeltaV: number;
  warnings: string[];
  verdict: { ok: boolean; margin: number };
  geometry: VehicleGeometry;
  fairings: FairingInfo[];
  /** Stability at liftoff (full) and with the first stage dry. */
  aero: { full: MassProperties; empty: MassProperties };
}

/** Commonly cited Δv to LEO: ~7.8 km/s orbital + 1.5–2.0 km/s losses
 * (Wikipedia delta-v budget; Stanford AA284A launch trajectory notes). */
export const LEO_BUDGET = 9_400;

// Structural dynamic-pressure limits [Pa] — engineering estimates with
// margin over the ~30 kPa a nominal ascent sees.
const MAX_Q_HULL = 160_000;
const MAX_Q_NOSE = 120_000;
const MAX_Q_FIN = 90_000;

/** Base drag coefficient (skin friction + base drag) added under the
 * nose contribution — engineering estimate for slender launchers. */
const CD_BASE = 0.15;
/** Nose Cd fallback for a blunt exposed face (Hoerner class). */
const CD_BLUNT = 0.7;
/** Usable tank fill fraction (ullage space). */
const TANK_FILL = 0.95;

export function compile(craft: Craft): Compiled {
  // ---- sections ----
  const section = new Map<string, number>();
  const strapOnSec = new Set<number>();
  const crossfeedSec = new Set<number>();
  const pylonParent = new Map<number, number>(); // strap-on section → sustainer section
  let maxSection = 0;
  const walk = (p: CraftPart, depth: number): void => {
    const def = partById(p.defId);
    const d = def.kind === 'decoupler' ? depth + 1 : depth;
    if (def.kind === 'decoupler' && p.attach.kind === 'radial') {
      strapOnSec.add(d);
      pylonParent.set(d, depth);
      if (def.crossfeed) crossfeedSec.add(d);
    }
    section.set(p.id, d);
    maxSection = Math.max(maxSection, d);
    for (const c of children(craft, p.id)) walk(c, d);
  };
  walk(craft.parts[craft.rootId]!, 0);

  let order = [...Array(maxSection + 1).keys()].reverse();
  if (
    craft.stageOrder.length === order.length &&
    [...craft.stageOrder].sort((a, b) => a - b).every((v, i) => v === i)
  ) {
    order = [...craft.stageOrder];
  }
  const burnIndexOf = (partId: string): number => order.indexOf(section.get(partId)!);

  const place = placements(craft);

  // ---- aggregate stages ----
  interface SecAgg {
    engines: Map<string, EngineGroup>;
    stage: Stage;
    partIds: string[];
    fluid: PropellantId | null;
    grain: number; // solid grain mass
    tankProp: Map<PropellantId, number>;
    liquidEngineCount: number;
  }
  const sections: SecAgg[] = [];
  for (let i = 0; i <= maxSection; i++) {
    sections.push({
      engines: new Map(),
      stage: { engines: [], tanks: [], extraDryMass: 0 },
      partIds: [],
      fluid: null,
      grain: 0,
      tankProp: new Map(),
      liquidEngineCount: 0,
    });
  }
  let rcsTorque = 0;
  let rcsThrust = 0;
  let rcsPropellant = 0;
  let wheelTorque = 0;
  let wheelCapacity = 0;
  let ullageMotors = 0;

  for (const p of Object.values(craft.parts)) {
    const def = partById(p.defId);
    const sec = sections[section.get(p.id)!]!;
    const n = instanceCount(craft, p.id);
    const pl = place.get(p.id)!;
    sec.partIds.push(p.id);
    rcsTorque += (def.rcsTorque ?? 0) * n + (def.control?.rcsTorque ?? 0) * n;
    rcsThrust += (def.control?.rcsThrust ?? 0) * n;
    rcsPropellant += (def.control?.rcsPropellant ?? 0) * n;
    wheelTorque += (def.control?.wheelTorque ?? 0) * n;
    wheelCapacity += (def.control?.wheelCapacity ?? 0) * n;

    if (def.kind === 'engine' && def.engineId) {
      const g = sec.engines.get(def.engineId);
      if (g) g.count += n;
      else sec.engines.set(def.engineId, { engine: engineById(def.engineId), count: n });
      sec.liquidEngineCount += n;
    } else if (def.kind === 'engine' && def.solidMotor && def.ullage) {
      // Dedicated ullage motors: settle chargers, not propulsion. Their
      // loaded mass rides as structure (25 kg grain — negligible drift).
      ullageMotors += n;
      sec.stage.extraDryMass = (sec.stage.extraDryMass ?? 0) + (def.dryMass + (def.propellant ?? 0)) * n;
    } else if (def.kind === 'engine' && def.solidMotor) {
      // Integrated solid: motor + casing + grain in one part.
      const g = sec.engines.get(def.solidMotor);
      if (g) g.count += n;
      else sec.engines.set(def.solidMotor, { engine: engineById(def.solidMotor), count: n });
      sec.grain += (def.propellant ?? 0) * n;
      sec.stage.extraDryMass = (sec.stage.extraDryMass ?? 0) + def.dryMass * n;
    } else if (def.kind === 'tank' && def.fluid) {
      // Volumetric tank: geometry × parametric length × fluid density.
      const r = def.maxRadius;
      const vol = Math.PI * r * r * pl.height;
      const prop = vol * TANK_FILL * propellantById(def.fluid).bulkDensity;
      const dry = vol * TANK_STRUCTURE_KG_PER_M3;
      sec.stage.tanks.push({
        id: def.id,
        name: def.name,
        fluid: def.fluid,
        volume: vol,
        propellantMass: prop * n,
        dryMass: dry * n,
        source: def.source,
      });
      sec.tankProp.set(def.fluid, (sec.tankProp.get(def.fluid) ?? 0) + prop * n);
    } else {
      sec.stage.extraDryMass = (sec.stage.extraDryMass ?? 0) + def.dryMass * n;
    }
  }

  const warnings: string[] = [];

  // Per-section fluid + pool bookkeeping. A section is solid-powered or
  // liquid; its liquid engines define the fluid the pool must carry.
  for (const sec of sections) {
    sec.stage.engines = [...sec.engines.values()];
    const liquids = sec.stage.engines.filter((g) => g.engine.propellant !== 'solid');
    const solids = sec.stage.engines.filter((g) => g.engine.propellant === 'solid');
    if (solids.length > 0 && sec.tankProp.size > 0) {
      warnings.push('A stage mixes a solid motor with liquid tanks — the tanks feed nothing there.');
    }
    if (liquids.length > 0) {
      sec.fluid = liquids[0]!.engine.propellant;
      if (liquids.some((g) => g.engine.propellant !== sec.fluid)) {
        warnings.push(`A stage mixes engine propellant types; only ${sec.fluid} tanks feed it.`);
      }
    } else if (solids.length > 0) {
      sec.fluid = 'solid';
    } else if (sec.tankProp.size > 0) {
      sec.fluid = [...sec.tankProp.keys()][0]!;
    }
    // Tanks whose fluid no engine in this section burns are dead weight —
    // still mass, but not in the burnable pool.
    for (const [fluid, mass] of sec.tankProp) {
      if (sec.fluid !== null && fluid !== sec.fluid && liquids.length > 0) {
        warnings.push(`A stage carries ${Math.round(mass / 1000)} t of ${fluid} its engines cannot burn.`);
      }
    }
    // Cluster cost: distributed thrust take-out points and per-engine
    // plumbing grow the thrust structure. ESTIMATE anchored to S-IC
    // (21.7 t structure / 33.4 MN) and F9 octaweb estimates:
    // mount = (T/g₀)·0.004·(1 + 0.08·(N−1)).
    const totalThrust = sec.stage.engines.reduce(
      (s, g) => s + Math.max(g.engine.thrustSL, g.engine.thrustVac) * g.count,
      0,
    );
    const nEng = sec.stage.engines.reduce((s, g) => s + g.count, 0);
    if (nEng > 0 && liquids.length > 0) {
      const mount = (totalThrust / G0) * 0.004 * (1 + 0.08 * (nEng - 1));
      sec.stage.extraDryMass = (sec.stage.extraDryMass ?? 0) + mount;
    }
  }

  const compiled: CompiledStage[] = order.map((si) => ({
    stage: sections[si]!.stage,
    partIds: sections[si]!.partIds,
    sectionIndex: si,
    strapOn: strapOnSec.has(si),
    crossfeed: crossfeedSec.has(si),
  }));

  // Solid grain rides in the stage's tank list as a cast-grain entry so
  // every mass aggregate (wet mass, Δv reports, pools) sees it.
  compiled.forEach((cs) => {
    const sec = sections[cs.sectionIndex]!;
    if (sec.grain > 0) {
      cs.stage.tanks.push({
        id: `grain-${cs.sectionIndex}`,
        name: 'Solid grain',
        fluid: 'solid',
        volume: sec.grain / propellantById('solid').bulkDensity,
        propellantMass: sec.grain,
        dryMass: 0, // casing already counted in extraDryMass
        source: 'Cast grain of the integrated solid motor (see the booster part)',
      });
    }
  });

  // ---- pools + parallel-burn phases ----
  const pools: PropellantPool[] = compiled.map((cs) => {
    const sec = sections[cs.sectionIndex]!;
    const fluid = sec.fluid ?? 'kerolox';
    const usable = sec.grain > 0 ? sec.grain : (sec.tankProp.get(fluid as PropellantId) ?? 0);
    return { fluid: fluid as PropellantId, mass: usable };
  });

  /** Stages burning during phase k: the phase's own stage, plus — when k
   * is a strap-on — every following strap-on ring and the first core
   * stage (all lit on the pad together, KSP-parallel style). */
  const phaseMembers = (k: number): number[] => {
    const members = [k];
    if (!compiled[k]!.strapOn) return members;
    for (let j = k + 1; j < compiled.length; j++) {
      members.push(j);
      if (!compiled[j]!.strapOn) break; // the sustainer core
    }
    return members;
  };

  const phases: PhasePlan[] = compiled.map((_cs, k) => {
    const groups: BurnGroup[] = [];
    for (const s of phaseMembers(k)) {
      const cs = compiled[s]!;
      if (cs.stage.engines.length === 0) continue;
      // Drain priority: crossfed strap-on pools outboard-first (fluid
      // must match), then the stage's own pool.
      for (const g of cs.stage.engines) {
        const drain: number[] = [];
        if (g.engine.propellant !== 'solid') {
          for (let p = k; p < s; p++) {
            if (compiled[p]!.strapOn && compiled[p]!.crossfeed && pools[p]!.fluid === g.engine.propellant) {
              drain.push(p);
            }
          }
        }
        drain.push(s);
        groups.push({ engines: [g], drain, stage: s });
      }
    }
    return { groups };
  });

  // Union engine list per phase so existing thrust/TWR aggregates see the
  // parallel burn (a strap-on phase includes the sustainer's engines).
  const phaseStages: Stage[] = compiled.map((cs, k) => {
    const members = phaseMembers(k);
    if (members.length === 1) return cs.stage;
    const engines: EngineGroup[] = [];
    for (const s of members) {
      for (const g of compiled[s]!.stage.engines) {
        const ex = engines.find((x) => x.engine.id === g.engine.id);
        if (ex) ex.count += g.count;
        else engines.push({ ...g });
      }
    }
    return { ...cs.stage, engines };
  });

  // ---- geometry + Barrowman + enclosure ----
  let refR = 0.1;
  for (const pl of place.values()) {
    if (pl.instances[0] && Math.hypot(pl.instances[0].x, pl.instances[0].z) < 1e-6 && !pl.def.fin) {
      refR = Math.max(refR, pl.def.maxRadius);
    }
  }
  const dRef = 2 * refR;

  // Fairing enclosure: parts wholly inside a fairing cavity.
  const fairings: FairingInfo[] = [];
  const enclosed = new Set<string>();
  for (const [id, pl] of place) {
    if (!pl.def.fairing) continue;
    const f = pl.def.fairing;
    const base = pl.instances[0]!;
    const inside: string[] = [];
    for (const [oid, opl] of place) {
      if (oid === id) continue;
      const oi = opl.instances[0]!;
      const lat = Math.hypot(oi.x, oi.z) + opl.def.maxRadius;
      if (lat <= f.innerRadius + 0.05 && oi.y >= base.y - 0.01 && oi.y + opl.height <= base.y + f.innerHeight + 0.05) {
        inside.push(oid);
        enclosed.add(oid);
      }
    }
    fairings.push({ partId: id, stage: burnIndexOf(id), mass: pl.def.dryMass, encloses: inside });
    if (inside.length === 0) warnings.push(`${pl.def.name} encloses nothing — dead mass.`);
  }

  const geomParts: GeomPart[] = [];
  const legs: LegInfo[] = [];
  const chutes: ChuteInfo[] = [];
  let length = 0;
  let finControlPerQ = 0;

  for (const [id, pl] of place) {
    const p = craft.parts[id]!;
    const def = pl.def;
    const inst0 = pl.instances[0]!;
    const n = instanceCount(craft, id);
    length = Math.max(length, inst0.y + pl.height);
    const lateral = Math.hypot(inst0.x, inst0.z);

    let cn = 0;
    let cnY = 0;
    if (enclosed.has(id)) {
      // Inside a fairing: no exposed aero surface.
    } else if (def.fin) {
      const parent = craft.parts[p.parentId!]!;
      const rBody = partById(parent.defId).maxRadius;
      const f = finSet(p.symmetry, def.fin.cr, def.fin.ct, def.fin.span, def.fin.sweep, rBody, dRef);
      const mult = n / p.symmetry;
      cn = f.cn * mult;
      cnY = cn * (inst0.y + def.fin.cr - f.xFromRootLE);
      if (def.control?.finControl) {
        // Active surface: torque/q ≈ n·A·C_Nδ·sin(δmax)·arm with C_Nδ ≈ 2
        // and δmax 20° (thin-plate heuristic — flagged approximation).
        // The lever arm is taken from the vehicle mid-height.
        const area = ((def.fin.cr + def.fin.ct) / 2) * def.fin.span;
        finControlPerQ += n * area * 2 * Math.sin((20 * Math.PI) / 180);
      }
    } else if (def.kind !== 'engine') {
      let rAbove = 0;
      if (p.attach.kind === 'below' && p.parentId) {
        rAbove = partById(craft.parts[p.parentId]!.defId).radiusBottom;
      }
      if (def.radiusTop > rAbove + 1e-6) {
        const c = (2 * ((2 * def.radiusTop) ** 2 - (2 * rAbove) ** 2)) / (dRef * dRef);
        cn += c * n;
        cnY += c * n * (inst0.y + pl.height);
      }
      for (const seg of def.segments) {
        if (Math.abs(seg.r1 - seg.r0) < 1e-6) continue;
        const hScale = pl.height / def.height;
        const segLen = (seg.y1 - seg.y0) * hScale;
        const t = transition(2 * seg.r1, 2 * seg.r0, segLen, dRef);
        cn += t.cn * n;
        cnY += t.cn * n * (inst0.y + seg.y1 * hScale - t.xFromFore);
      }
    }

    if (def.leg && p.parentId) {
      const parentR = partById(craft.parts[p.parentId!]!.defId).maxRadius;
      legs.push({
        partId: id,
        stage: burnIndexOf(id),
        footprint: parentR + def.leg.reach * Math.sin((50 * Math.PI) / 180),
      });
    }
    if (def.chute) {
      chutes.push({
        partId: id,
        stage: burnIndexOf(id),
        cdA: def.chute.cdA * n,
        safeQ: def.chute.safeQ,
        y: inst0.y + pl.height,
      });
    }

    // Masses for the geometry model (volumetric tanks recomputed here).
    let dryMass = def.dryMass * n;
    let propMass = (def.propellant ?? 0) * n;
    if (def.kind === 'tank' && def.fluid) {
      const vol = Math.PI * def.maxRadius * def.maxRadius * pl.height;
      dryMass = vol * TANK_STRUCTURE_KG_PER_M3 * n;
      const sec = sections[section.get(id)!]!;
      // Dead-fluid tanks (no engine burns them) keep their load as mass.
      propMass = vol * TANK_FILL * propellantById(def.fluid).bulkDensity * n;
      if (sec.fluid !== null && sec.fluid !== def.fluid && sec.stage.engines.some((g) => g.engine.propellant !== 'solid')) {
        dryMass += propMass; // never drains
        propMass = 0;
      }
    }

    geomParts.push({
      partId: id,
      name: def.name,
      stage: burnIndexOf(id),
      y: inst0.y,
      height: pl.height,
      radius: def.maxRadius,
      lateral,
      dryMass,
      propellant: propMass,
      cnAlpha: cn,
      yCp: cn !== 0 ? cnY / cn : 0,
      maxQ: def.kind === 'fin' ? MAX_Q_FIN : def.kind === 'nose' ? MAX_Q_NOSE : MAX_Q_HULL,
      shedable: def.kind === 'fin' || def.kind === 'nose',
    });
  }

  const geometry: VehicleGeometry = {
    parts: geomParts,
    refDiameter: dRef,
    refArea: Math.PI * refR * refR,
    length,
    legs,
    chutes,
    fairings: fairings.map((f) => ({ partId: f.partId, mass: f.mass })),
  };

  // ---- per-stage drag (cd × frontal area), faired and bare ----
  const dragFor = (si: number, faired: boolean): { cd: number; area: number } => {
    let maxR = 0.1;
    let frontY = -Infinity;
    let frontCd = CD_BLUNT;
    for (const [id, pl] of place) {
      if (burnIndexOf(id) < si) continue;
      if (pl.def.fin) continue;
      if (faired && enclosed.has(id)) continue;
      if (!faired && pl.def.fairing) continue;
      const inst0 = pl.instances[0]!;
      const lat = Math.hypot(inst0.x, inst0.z);
      maxR = Math.max(maxR, lat + pl.def.maxRadius);
      const top = inst0.y + pl.height;
      if (top > frontY && lat < pl.def.maxRadius + 0.2) {
        frontY = top;
        frontCd = pl.def.noseCd ?? CD_BLUNT;
      }
    }
    return { cd: CD_BASE + frontCd, area: Math.PI * maxR * maxR };
  };
  const drag = {
    cdFaired: compiled.map((_s, i) => dragFor(i, true).cd),
    cdBare: compiled.map((_s, i) => dragFor(i, false).cd),
    areaFaired: compiled.map((_s, i) => dragFor(i, true).area),
    areaBare: compiled.map((_s, i) => dragFor(i, false).area),
  };

  const vehicle: Vehicle = {
    stages: phaseStages,
    payloadMass: 0,
    cd: drag.cdFaired[0] ?? 0.5,
    area: drag.areaFaired[0] ?? 10,
    geometry,
    // Section-only dry mass per phase (jettisoned at phase end) and the
    // strap-on flags the sim needs for sustainer continuation.
    sepMass: compiled.map((cs, k) => {
      const dry =
        (cs.stage.extraDryMass ?? 0) +
        cs.stage.engines.reduce((s, g) => s + g.engine.mass * g.count, 0) +
        cs.stage.tanks.reduce((s, t) => s + t.dryMass, 0);
      // Propellant the engines cannot burn (mismatched fluid) never
      // drains — it rides and leaves with the section.
      const totalProp = cs.stage.tanks.reduce((s, t) => s + t.propellantMass, 0);
      const dead = Math.max(0, totalProp - pools[k]!.mass);
      return dry + dead;
    }),
    strapOn: compiled.map((cs) => cs.strapOn),
    rcsTorque,
    rcsThrust,
    rcsPropellant,
    wheelTorque,
    wheelCapacity,
    finControlPerQ,
    pools,
    phases,
    drag,
    ullageMotors,
  };

  const reports = vehicle.stages.map((_s, i) => stageReport(vehicle, i));
  // Crossfeed/parallel honesty: overwrite the serial per-stage estimate
  // with the closed-form phase walk (identical for serial vehicles). The
  // SL Δv keeps its meaning via the phase's vₑ ratio, and TWR rows rescale
  // to the walk's honest ignition/burnout masses (thrust is unchanged:
  // twr·mass = thrust/g).
  const phaseWalk = phaseWalkReport(vehicle);
  if (phaseWalk) {
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i]!;
      const w = phaseWalk[i]!;
      const veRatio = r.deltaV > 0 ? r.deltaVSeaLevel / r.deltaV : 0;
      r.twrIgnition = r.ignitionMass > 0 ? (r.twrIgnition * r.ignitionMass) / w.ignitionMass : r.twrIgnition;
      r.twrBurnout = r.burnoutMass > 0 ? (r.twrBurnout * r.burnoutMass) / w.burnoutMass : r.twrBurnout;
      r.deltaV = w.deltaV;
      r.deltaVSeaLevel = w.deltaV * veRatio;
      r.burnTime = w.burnTime;
      r.ignitionMass = w.ignitionMass;
      r.burnoutMass = w.burnoutMass;
    }
  }
  const dv = phaseWalk ? phaseWalk.reduce((s, w) => s + w.deltaV, 0) : totalDeltaV(vehicle);
  const aero = {
    full: massProperties(geometry, 0, 1),
    empty: massProperties(geometry, 0, 0),
  };

  // ---- warnings ----
  const first = compiled[0];
  if (first && phaseStages[0]!.engines.length === 0) warnings.push('First stage has no engines.');
  for (const g of phaseStages[0]?.engines ?? []) {
    if (isFinite(g.engine.maxAmbientPressure) && g.engine.maxAmbientPressure < 101_325) {
      warnings.push(
        `${g.engine.name} separates at sea level (limit ${(g.engine.maxAmbientPressure / 1000).toFixed(1)} kPa) — it will be DESTROYED on a pad start.`,
      );
    }
  }
  const r0 = reports[0];
  if (r0 && isFinite(r0.twrIgnition) && r0.twrIgnition > 0 && r0.twrIgnition < 1) {
    warnings.push(`Liftoff TWR ${r0.twrIgnition.toFixed(2)} < 1 — it will not leave the pad.`);
  }
  for (let i = 1; i < compiled.length; i++) {
    const c = compiled[i]!;
    if (c.stage.tanks.length > 0 && c.stage.engines.length === 0 && c.stage.tanks.some((t) => t.propellantMass > 0)) {
      warnings.push(`Stage ${i + 1} carries propellant but has no engine.`);
    }
    // Pump-fed relight without settling support: playable, but warn.
    const needsUllage = c.stage.engines.some((g) => !g.engine.ullageImmune && g.engine.propellant !== 'solid');
    if (i > 0 && needsUllage && rcsThrust === 0) {
      warnings.push(
        `Stage ${i + 1} has pump-fed engines but the vehicle has no RCS thrust or ullage motors — freefall relights will flame out.`,
      );
    }
  }
  // Asymmetry: the planar 3-DOF sim cannot represent out-of-plane torque.
  let offX = 0;
  let offZ = 0;
  let mTot = 0;
  for (const [id, pl] of place) {
    const def = pl.def;
    const perInst = (def.dryMass + (def.propellant ?? 0)) * (instanceCount(craft, id) / pl.instances.length);
    for (const i of pl.instances) {
      offX += perInst * i.x;
      offZ += perInst * i.z;
      mTot += perInst;
    }
  }
  const off = mTot > 0 ? Math.hypot(offX, offZ) / mTot : 0;
  if (off > 0.05) {
    warnings.push(
      `Asymmetric build: CoM is ${off.toFixed(2)} m off-axis. The planar sim ignores the resulting out-of-plane torque — add symmetry.`,
    );
  }
  for (const p of Object.values(craft.parts)) {
    const def = partById(p.defId);
    const compact =
      def.kind === 'fin' || def.kind === 'chute' || def.kind === 'leg' || def.kind === 'control' || !!def.fairing;
    if (p.attach.kind === 'radial' && p.symmetry === 1 && !compact) {
      warnings.push(`1× ${def.name} attached radially without symmetry — asymmetric.`);
    }
  }
  if (p0Unstable(aero.full)) {
    warnings.push(
      `Aerodynamically unstable: CoP ${(-aero.full.staticMarginCal).toFixed(1)} calibers ahead of CoM — it will flip at max-Q unless gimbal authority holds it. Move fins aft or mass forward.`,
    );
  }

  return {
    vehicle,
    stages: compiled,
    reports,
    totalDeltaV: dv,
    warnings,
    verdict: { ok: dv >= LEO_BUDGET, margin: dv - LEO_BUDGET },
    geometry,
    fairings,
    aero,
  };
}

const p0Unstable = (m: MassProperties): boolean => m.cnAlpha > 0 && m.staticMarginCal < 0;
