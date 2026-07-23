// Compile the craft tree into (a) the aggregate Vehicle the physics core
// flies, (b) the part-layout geometry that drives CoM/inertia/CoP, and
// (c) the per-stage report rows + warnings the builder shows live.
//
// Sectioning: each decoupler separates itself and everything hanging from
// it — sections are numbered by decouplers crossed from the root (0 =
// uppermost). Burn order defaults bottom-up; craft.stageOrder reorders.
//
// Aerodynamics: Barrowman components (see physics/massmodel.ts) walked
// over the actual part profile: exposed top faces wider than the part
// above act as shoulders/nose discs, sloped radius changes as transitions,
// fins via the fin-set formula. Engine bells sit in separated base flow
// and contribute nothing. Reference diameter = widest main-stack body.

import { engineById } from '../physics/parts';
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
  EngineGroup,
  Stage,
  StageReport,
  Vehicle,
  stageReport,
  totalDeltaV,
} from '../physics/vehicle';
import { partById } from './catalog';
import { Craft, CraftPart, children, instanceCount, placements } from './craft';

export interface CompiledStage {
  stage: Stage;
  partIds: string[];
  sectionIndex: number;
}

export interface Compiled {
  vehicle: Vehicle;
  stages: CompiledStage[]; // burn order (index 0 burns first)
  reports: StageReport[];
  totalDeltaV: number;
  warnings: string[];
  verdict: { ok: boolean; margin: number };
  geometry: VehicleGeometry;
  /** Stability at liftoff (full) and with the first stage dry. */
  aero: { full: MassProperties; empty: MassProperties };
}

/** Commonly cited Δv to LEO: ~7.8 km/s orbital + 1.5–2.0 km/s losses
 * (Wikipedia delta-v budget; Stanford AA284A launch trajectory notes). */
export const LEO_BUDGET = 9_400;

// Structural dynamic-pressure limits [Pa] — engineering estimates with
// margin over the ~30 kPa a nominal ascent sees. Aero surfaces shed;
// hull failure destroys the vehicle.
const MAX_Q_HULL = 160_000;
const MAX_Q_NOSE = 120_000;
const MAX_Q_FIN = 90_000;

export function compile(craft: Craft): Compiled {
  // ---- sections ----
  const section = new Map<string, number>();
  let maxSection = 0;
  const walk = (p: CraftPart, depth: number): void => {
    const def = partById(p.defId);
    const d = def.kind === 'decoupler' ? depth + 1 : depth;
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

  // ---- aggregate stages ----
  const sections: { engines: Map<string, EngineGroup>; stage: Stage; partIds: string[] }[] = [];
  for (let i = 0; i <= maxSection; i++) {
    sections.push({ engines: new Map(), stage: { engines: [], tanks: [], extraDryMass: 0 }, partIds: [] });
  }
  let rcsTorque = 0;
  for (const p of Object.values(craft.parts)) {
    const def = partById(p.defId);
    const sec = sections[section.get(p.id)!]!;
    const n = instanceCount(craft, p.id);
    sec.partIds.push(p.id);
    rcsTorque += (def.rcsTorque ?? 0) * n;
    if (def.kind === 'engine' && def.engineId) {
      const g = sec.engines.get(def.engineId);
      if (g) g.count += n;
      else sec.engines.set(def.engineId, { engine: engineById(def.engineId), count: n });
    } else if (def.kind === 'tank') {
      sec.stage.tanks.push({
        id: def.id,
        name: def.name,
        propellantMass: def.propellant! * n,
        dryMass: def.dryMass * n,
      });
    } else {
      sec.stage.extraDryMass = (sec.stage.extraDryMass ?? 0) + def.dryMass * n;
    }
  }
  for (const s of sections) s.stage.engines = [...s.engines.values()];

  const compiled: CompiledStage[] = order.map((si) => ({
    stage: sections[si]!.stage,
    partIds: sections[si]!.partIds,
    sectionIndex: si,
  }));

  // ---- geometry + Barrowman ----
  const place = placements(craft);
  // Reference diameter: widest on-axis body.
  let refR = 0.1;
  for (const pl of place.values()) {
    if (pl.instances[0] && Math.hypot(pl.instances[0].x, pl.instances[0].z) < 1e-6 && !pl.def.fin) {
      refR = Math.max(refR, pl.def.maxRadius);
    }
  }
  const dRef = 2 * refR;
  const geomParts: GeomPart[] = [];
  const legs: LegInfo[] = [];
  const chutes: ChuteInfo[] = [];
  let length = 0;

  for (const [id, pl] of place) {
    const p = craft.parts[id]!;
    const def = pl.def;
    const inst0 = pl.instances[0]!;
    const n = instanceCount(craft, id);
    length = Math.max(length, inst0.y + def.height);
    const lateral = Math.hypot(inst0.x, inst0.z);

    let cn = 0;
    let cnY = 0;
    if (def.fin) {
      // Fin set: the formula covers this part's own symmetry ring; extra
      // multiplicity (fins on each of n radial boosters) scales linearly.
      const parent = craft.parts[p.parentId!]!;
      const rBody = partById(parent.defId).maxRadius;
      const f = finSet(p.symmetry, def.fin.cr, def.fin.ct, def.fin.span, def.fin.sweep, rBody, dRef);
      const mult = n / p.symmetry;
      cn = f.cn * mult;
      cnY = cn * (inst0.y + def.fin.cr - f.xFromRootLE);
    } else if (def.kind !== 'engine') {
      // Radius of whatever sits directly above this part's top face.
      let rAbove = 0;
      if (p.attach.kind === 'below' && p.parentId) {
        rAbove = partById(craft.parts[p.parentId]!.defId).radiusBottom;
      }
      // Exposed top face wider than the part above → shoulder/nose disc.
      if (def.radiusTop > rAbove + 1e-6) {
        const c = (2 * ((2 * def.radiusTop) ** 2 - (2 * rAbove) ** 2)) / (dRef * dRef);
        cn += c * n;
        cnY += c * n * (inst0.y + def.height);
      }
      // Sloped internal segments: transitions (fore = upper radius).
      for (const seg of def.segments) {
        if (Math.abs(seg.r1 - seg.r0) < 1e-6) continue;
        const segLen = seg.y1 - seg.y0;
        const t = transition(2 * seg.r1, 2 * seg.r0, segLen, dRef);
        // xFromFore is measured downward from the segment top.
        cn += t.cn * n;
        cnY += t.cn * n * (inst0.y + seg.y1 - t.xFromFore);
      }
    }

    if (def.leg && p.parentId) {
      // Deployed footprint: leg splays ~50° from the hull.
      const parentR = partById(this_parent(craft, p).defId).maxRadius;
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
        y: inst0.y + def.height,
      });
    }

    geomParts.push({
      partId: id,
      name: def.name,
      stage: burnIndexOf(id),
      y: inst0.y,
      height: def.height,
      radius: def.maxRadius,
      lateral,
      dryMass: def.dryMass * n,
      propellant: (def.propellant ?? 0) * n,
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
  };

  const vehicle: Vehicle = {
    stages: compiled.map((c) => c.stage),
    payloadMass: 0,
    cd: 0.5, // drag convention: Cd against the frontal area below
    area: frontalArea(craft),
    geometry,
    rcsTorque,
  };

  const reports = vehicle.stages.map((_s, i) => stageReport(vehicle, i));
  const dv = totalDeltaV(vehicle);
  const aero = {
    full: massProperties(geometry, 0, 1),
    empty: massProperties(geometry, 0, 0),
  };

  // ---- warnings ----
  const warnings: string[] = [];
  const first = compiled[0];
  if (first && first.stage.engines.length === 0) warnings.push('First stage has no engines.');
  if (first && first.stage.engines.some((g) => g.engine.vacuumOnly)) {
    warnings.push('Vacuum-only engine in the first stage — it cannot run at sea level.');
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
    // Compact accessories (fins/chutes/legs) are light enough that a lone
    // one doesn't meaningfully unbalance the vehicle.
    const compact = def.kind === 'fin' || def.kind === 'chute' || def.kind === 'leg';
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
    aero,
  };
}

const p0Unstable = (m: MassProperties): boolean => m.cnAlpha > 0 && m.staticMarginCal < 0;

const this_parent = (craft: Craft, p: CraftPart): CraftPart => craft.parts[p.parentId!]!;

/** Frontal reference area for drag: circle of the widest cross-section
 * including radial bodies (distinct from the Barrowman reference area,
 * which is the main-stack body; each is used only with its own convention). */
function frontalArea(craft: Craft): number {
  let maxR = 0;
  for (const p of Object.values(craft.parts)) {
    const def = partById(p.defId);
    if (def.fin) continue;
    if (p.attach.kind === 'radial') {
      const parent = craft.parts[p.parentId!]!;
      const pDef = partById(parent.defId);
      maxR = Math.max(maxR, pDef.maxRadius + 2 * def.maxRadius);
    } else {
      maxR = Math.max(maxR, def.maxRadius);
    }
  }
  return Math.PI * maxR * maxR;
}
