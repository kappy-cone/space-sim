// The craft: a tree of parts joined at attachment nodes.
//
// - 'below'  : child's top face against parent's bottom face (stack)
// - 'above'  : child's bottom face against parent's top face (stack)
// - 'radial' : child's side against parent's side at (angle, y), with a
//              symmetry count that mirrors the child n ways around the axis
//
// Engines use `symmetry` as cluster count (n engines on one mount).
// All positions are derived — the tree is the single source of truth.

import { PartDef, partById, radiusAt } from './catalog';

export type Attach =
  | { kind: 'below' }
  | { kind: 'above' }
  | { kind: 'radial'; angle: number; y: number }; // parent-local

export interface CraftPart {
  id: string;
  defId: string;
  parentId: string | null;
  attach: Attach;
  symmetry: number; // radial copies, or engine cluster count
  /** Parametric length [m] for tanks (clamped to def.lengthRange).
   * Length is a build-time parameter — the discrete axes are
   * fluid × diameter; two tanks differing only in length are not parts. */
  length?: number;
}

export interface Craft {
  name: string;
  parts: Record<string, CraftPart>;
  rootId: string;
  /** Stage firing order as section indices (see compile.ts); reordered
   * by the staging list UI. */
  stageOrder: number[];
  /** Vehicle class, chosen at build start. Absent = 'rocket', so every
   * previously saved craft loads (and compiles) exactly as before. The
   * class — not the parts — gates plane aero at compile. */
  vehicleClass?: 'rocket' | 'plane';
}

let counter = 0;
export const freshId = (): string => `p${++counter}_${Date.now().toString(36)}`;

/** The canonical two-stage reference rocket: capsule / 84 t tank / MVac /
 * decoupler / 400 t tank / 9× Merlin cluster / 4 large tail fins. Stable,
 * ~11.8 km/s — the known-good test vehicle and the default craft. */
export function referenceCraft(): Craft {
  const P = (
    id: string,
    defId: string,
    parentId: string | null,
    attach: Attach,
    symmetry = 1,
  ): [string, CraftPart] => [id, { id, defId, parentId, attach, symmetry }];
  return {
    name: 'Reference',
    rootId: 'root',
    stageOrder: [],
    parts: Object.fromEntries([
      P('root', 'capsule', null, { kind: 'below' }),
      P('s2tank', 't37-m', 'root', { kind: 'below' }),
      P('s2eng', 'e-merlin-vac', 's2tank', { kind: 'below' }),
      P('dec', 'dec-37', 's2eng', { kind: 'below' }),
      P('s1tank', 't37-xl', 'dec', { kind: 'below' }),
      P('s1eng', 'e-merlin-1d', 's1tank', { kind: 'below' }, 9),
      // 8 large tail fins: the full-load CoM sits low (settled propellant),
      // so it takes this much fin area to keep the CoP below it at liftoff.
      P('fins', 'fin-l', 's1tank', { kind: 'radial', angle: Math.PI / 8, y: 1.3 }, 8),
    ]),
  };
}

/** Starter builds: sound propulsion and positive static margin, pinned by
 * the compile test suite. Deliberately diverse across the roster: every
 * propellant type, solids on pylons (parallel staging), a hypergolic
 * service module, an extendable-nozzle hydrolox upper, fairings and
 * adapters — each starter demonstrates a decision axis. */
export function starterCrafts(): { name: string; craft: Craft }[] {
  const make = (name: string): { craft: Craft; P: (id: string, defId: string, parentId: string | null, attach: Attach, symmetry?: number, length?: number) => void } => {
    const craft: Craft = { name, rootId: 'root', stageOrder: [], parts: {} };
    const P = (id: string, defId: string, parentId: string | null, attach: Attach, symmetry = 1, length?: number): void => {
      craft.parts[id] = { id, defId, parentId, attach, symmetry, ...(length !== undefined ? { length } : {}) };
    };
    return { craft, P };
  };

  // Heavy Lifter — Atlas-V-shaped: single-stick RD-180 kerolox core,
  // two GEM-40 solids on separating pylons (parallel staging: everything
  // lights on the pad, the grain thrust curves show in the flight data),
  // and a hydrolox RL10B-2 "Centaur" upper with an extendable nozzle.
  // The Centaur carries a DCSS-class load (8 m tank): the ground-lit
  // RD-180 burns to depletion, so the restartable upper stage does the
  // whole insertion — a long TWR < 1 burn that needs the propellant.
  // Eight tail fins hold the CoP near-neutral (−0.9 cal): at six it
  // flipped at max-Q and tumbled away ~2.7 km/s in steering loss.
  const heavy = make('Heavy Lifter');
  heavy.P('root', 'capsule', null, { kind: 'below' });
  heavy.P('dec3', 'dec-24', 'root', { kind: 'below' });
  heavy.P('centaur', 'h24', 'dec3', { kind: 'below' }, 1, 8);
  heavy.P('cengine', 'e-rl10b2', 'centaur', { kind: 'below' });
  heavy.P('dec2', 'dec-24', 'cengine', { kind: 'below' });
  heavy.P('ad1', 'adapter-37-24', 'dec2', { kind: 'below' });
  heavy.P('coretank', 't37-m', 'ad1', { kind: 'below' }, 1, 16);
  heavy.P('coreeng', 'e-rd180', 'coretank', { kind: 'below' });
  heavy.P('pylons', 'pylon', 'coretank', { kind: 'radial', angle: 0.2, y: 10 }, 2);
  heavy.P('srbs', 'srb-gem40', 'pylons', { kind: 'below' });
  heavy.P('fins', 'fin-l', 'coretank', { kind: 'radial', angle: 1.1, y: 1.0 }, 8);
  heavy.P('drogue', 'chute-drogue', 'root', { kind: 'radial', angle: 0.9, y: 1.5 });
  heavy.P('main', 'chute-main', 'root', { kind: 'radial', angle: 2.9, y: 1.5 });

  // Crew Ferry — Shuttle-style insertion: the kerolox lower stack flies a
  // deliberately suborbital profile and the capsule's hypergolic OMS
  // (pressure-fed, ullage-immune, restarts forever) finishes the orbit
  // and does the deorbit burn. Chutes bring it home.
  const ferry = make('Crew Ferry');
  ferry.P('root', 'capsule', null, { kind: 'below' });
  ferry.P('om-tank', 'hyp24', 'root', { kind: 'below' }, 1, 1.8);
  ferry.P('om-eng', 'e-aj10', 'om-tank', { kind: 'below' }, 2);
  ferry.P('dec3', 'dec-24', 'om-eng', { kind: 'below' });
  ferry.P('ad2', 'adapter-37-24', 'dec3', { kind: 'below' });
  ferry.P('s2tank', 't37-m', 'ad2', { kind: 'below' }, 1, 8);
  ferry.P('s2eng', 'e-merlin-vac', 's2tank', { kind: 'below' });
  ferry.P('dec2', 'dec-37', 's2eng', { kind: 'below' });
  ferry.P('s1tank', 't37-xl', 'dec2', { kind: 'below' }, 1, 24);
  ferry.P('s1eng', 'e-merlin-1d', 's1tank', { kind: 'below' }, 9);
  ferry.P('fins', 'fin-l', 's1tank', { kind: 'radial', angle: Math.PI / 8, y: 1.3 }, 8);
  ferry.P('drogue', 'chute-drogue', 'root', { kind: 'radial', angle: 0.9, y: 1.5 });
  ferry.P('main', 'chute-main', 'root', { kind: 'radial', angle: 2.9, y: 1.5 });

  // Moon Freighter — mixed staging the Saturn way: kerolox below,
  // hydrogen above. The RL10B-2 upper stage carries the extendable
  // nozzle, ullage motors for its restart, and hydrolox boiloff makes
  // the mission clock real. Probe + fairing on top.
  const freighter = make('Moon Freighter');
  freighter.P('root', 'probe', null, { kind: 'below' });
  freighter.P('rcs', 'rcs-quad', 'root', { kind: 'radial', angle: 0.5, y: 0.45 }, 2);
  freighter.P('ad3', 'adapter-24-12', 'root', { kind: 'below' });
  freighter.P('s3tank', 'h24', 'ad3', { kind: 'below' }, 1, 7);
  freighter.P('ull', 'ullage-motor', 's3tank', { kind: 'radial', angle: 0.3, y: 1.0 }, 2);
  freighter.P('fair', 'fairing-24', 's3tank', { kind: 'radial', angle: 0, y: 6.99 });
  freighter.P('s3eng', 'e-rl10b2', 's3tank', { kind: 'below' });
  freighter.P('dec2', 'dec-24', 's3eng', { kind: 'below' });
  freighter.P('ad1', 'adapter-37-24', 'dec2', { kind: 'below' });
  freighter.P('s2tank', 't37-m', 'ad1', { kind: 'below' }, 1, 9);
  freighter.P('s2eng', 'e-merlin-vac', 's2tank', { kind: 'below' });
  freighter.P('dec1', 'dec-37', 's2eng', { kind: 'below' });
  freighter.P('s1tank', 't37-xl', 'dec1', { kind: 'below' }, 1, 22);
  freighter.P('s1eng', 'e-merlin-1d', 's1tank', { kind: 'below' }, 9);
  freighter.P('fins', 'fin-l', 's1tank', { kind: 'radial', angle: Math.PI / 8, y: 1.3 }, 8);

  // Test Lander — kerolox Rutherford pair with legs: the drop-test and
  // suicide-burn workhorse (deep throttle, five spark relights).
  const lander = make('Test Lander');
  lander.P('root', 'probe', null, { kind: 'below' });
  lander.P('tank', 't12-s', 'root', { kind: 'below' });
  lander.P('eng', 'e-rutherford', 'tank', { kind: 'below' }, 2);
  lander.P('legs', 'leg-s', 'tank', { kind: 'radial', angle: 0.3, y: 0.8 }, 4);
  lander.P('fins', 'fin-m', 'tank', { kind: 'radial', angle: 1.1, y: 0.8 }, 8);

  // Moon Hopper — the hypergolic answer: pressure-fed AJ10 lights in
  // freefall every time (no ullage, no ignition budget), at the price of
  // Isp and thrust. Vacuum nozzle: moon duty only — it separates and
  // dies below ~5 kPa ambient. Pair it with a delivery stack.
  const hopper = make('Moon Hopper');
  hopper.P('root', 'probe', null, { kind: 'below' });
  hopper.P('rcs', 'rcs-quad', 'root', { kind: 'radial', angle: 0.5, y: 0.45 }, 2);
  hopper.P('tank', 'hyp12', 'root', { kind: 'below' }, 1, 2.2);
  hopper.P('eng', 'e-aj10', 'tank', { kind: 'below' });
  hopper.P('legs', 'leg-s', 'tank', { kind: 'radial', angle: 0.3, y: 1.1 }, 4);

  // ---- plane class: three starters, one per propulsion/wing niche.
  // Streamlined: nose cone forward, jet(s) aft, wings mid-fuselage
  // tuned for a mid-band static margin, gear on the belly. (The ramjet
  // has no starter ON PURPOSE — the RJ43's testbed, the X-7, was
  // air-launched, which is exactly what the release pylon is for.)

  // Gull Trainer — one turbofan, big wing, fixed gear: slow, floaty,
  // forgiving. The 20×-Isp demonstrator: hours of air on 4 t of fuel.
  const gull = make('Gull Trainer');
  gull.P('root', 'nose-12', null, { kind: 'below' });
  gull.P('fus', 'jf12', 'root', { kind: 'below' }, 1, 5);
  gull.P('eng', 'e-cfm56', 'fus', { kind: 'below' });
  gull.P('wing', 'wing-swept', 'fus', { kind: 'radial', angle: 0, y: 3.6 });
  gull.P('tail', 'tailplane', 'fus', { kind: 'radial', angle: 0, y: 0.3 });
  // Retractable gear even on the trainer: a CFM56 at full throttle
  // passes the fixed gear's 8 kPa limit in under 30 s — fixed gear is
  // for builds that CAN'T outrun it (sailplane-wing airframes).
  gull.P('gear', 'gear-retract', 'fus', { kind: 'radial', angle: Math.PI, y: 1.5 });

  // Stratoliner — the transport workhorse: twin turbofans, 34 t of
  // fuel, retractable gear. Ferry/cargo profile to M0.9 / 12 km.
  const strato = make('Stratoliner');
  strato.P('root', 'nose-24', null, { kind: 'below' });
  strato.P('fus', 'jf24', 'root', { kind: 'below' }, 1, 10);
  strato.P('eng', 'e-cfm56', 'fus', { kind: 'below' }, 2);
  strato.P('wing', 'wing-swept', 'fus', { kind: 'radial', angle: 0, y: 6.4 });
  strato.P('tail', 'tailplane', 'fus', { kind: 'radial', angle: 0, y: 0.4 });
  strato.P('gear', 'gear-retract', 'fus', { kind: 'radial', angle: Math.PI, y: 2 });

  // Silver Dart — Concorde-proportioned supersonic cruiser: six
  // afterburning J79s in mid-ship pods (tail-stacked engines would drag
  // the CG aft of the delta's neutral point — Concorde managed CG by
  // pumping fuel; we manage it by layout), the wet delta far aft with
  // elevons for trim (no tailplane — the delta trims itself), M2 dash.
  const dart = make('Silver Dart');
  dart.P('root', 'nose-24', null, { kind: 'below' });
  dart.P('fus', 'jf24', 'root', { kind: 'below' }, 1, 14);
  dart.P('eng', 'e-j79', 'fus', { kind: 'radial', angle: 0.3, y: 4 }, 6);
  dart.P('wing', 'wing-delta', 'fus', { kind: 'radial', angle: 0, y: 0.2 });
  dart.P('gear', 'gear-retract', 'fus', { kind: 'radial', angle: Math.PI, y: 3 });

  // Air Launcher — the air-launch sortie (X-7 practice: the RJ43's
  // testbed was carried aloft and dropped, then boosted past ramjet
  // light-off). Carrier: Stratoliner-derived. Payload on the release
  // pylon: a two-stage dart — J79 boost stage pushes it from the drop
  // Mach through transonic to ramjet light-off (~M1.9), stages away,
  // and the RJ43 takes it to M3+. Release spawns the dart as its own
  // vessel; the carrier keeps flying and can land.
  const airl = make('Air Launcher');
  airl.P('root', 'nose-24', null, { kind: 'below' });
  airl.P('fus', 'jf24', 'root', { kind: 'below' }, 1, 10);
  airl.P('eng', 'e-cfm56', 'fus', { kind: 'below' }, 2);
  airl.P('wing', 'wing-swept', 'fus', { kind: 'radial', angle: 0, y: 6.2 });
  airl.P('tail', 'tailplane', 'fus', { kind: 'radial', angle: 0, y: 0.4 });
  airl.P('gear', 'gear-retract', 'fus', { kind: 'radial', angle: Math.PI, y: 2 });
  airl.P('pylon', 'pylon-release', 'fus', { kind: 'radial', angle: Math.PI, y: 8 });
  airl.P('dart-nose', 'nose-12', 'pylon', { kind: 'below' });
  airl.P('dart-tank2', 'jf12', 'dart-nose', { kind: 'below' }, 1, 1.5);
  airl.P('dart-ram', 'e-rj43', 'dart-tank2', { kind: 'below' });
  airl.P('dart-fins2', 'fin-s', 'dart-tank2', { kind: 'radial', angle: 0.5, y: 0.3 }, 4);
  airl.P('dart-dec', 'dec-12', 'dart-ram', { kind: 'below' });
  airl.P('dart-tank1', 'jf12', 'dart-dec', { kind: 'below' }, 1, 2);
  airl.P('dart-jet', 'e-j79', 'dart-tank1', { kind: 'below' });
  airl.P('dart-fins1', 'fin-s', 'dart-tank1', { kind: 'radial', angle: 0.2, y: 0.4 }, 4);

  gull.craft.vehicleClass = 'plane';
  strato.craft.vehicleClass = 'plane';
  dart.craft.vehicleClass = 'plane';
  airl.craft.vehicleClass = 'plane';

  return [
    { name: 'Reference Orbiter', craft: referenceCraft() },
    { name: 'Heavy Lifter', craft: heavy.craft },
    { name: 'Crew Ferry', craft: ferry.craft },
    { name: 'Moon Freighter', craft: freighter.craft },
    { name: 'Test Lander', craft: lander.craft },
    { name: 'Moon Hopper', craft: hopper.craft },
    { name: 'Gull Trainer', craft: gull.craft },
    { name: 'Stratoliner', craft: strato.craft },
    { name: 'Silver Dart', craft: dart.craft },
    { name: 'Air Launcher', craft: airl.craft },
  ];
}

export function newCraft(rootDefId: string): Craft {
  const rootId = freshId();
  return {
    name: 'Untitled Craft',
    parts: { [rootId]: { id: rootId, defId: rootDefId, parentId: null, attach: { kind: 'below' }, symmetry: 1 } },
    rootId,
    stageOrder: [],
  };
}

export function children(craft: Craft, id: string): CraftPart[] {
  return Object.values(craft.parts).filter((p) => p.parentId === id);
}

export function subtreeIds(craft: Craft, id: string): string[] {
  return children(craft, id).flatMap((c) => [c.id, ...subtreeIds(craft, c.id)]);
}

export function stackChild(craft: Craft, id: string, kind: 'below' | 'above'): CraftPart | undefined {
  return children(craft, id).find((c) => c.attach.kind === kind);
}

/** Can `defId` attach to `parent` at the given node right now? */
export function canAttach(craft: Craft, parentId: string, defId: string, attach: Attach): boolean {
  const parent = craft.parts[parentId];
  if (!parent) return false;
  const pDef = partById(parent.defId);
  const cDef = partById(defId);
  if (attach.kind === 'below') {
    return pDef.stackBottom && cDef.stackTop && !stackChild(craft, parentId, 'below');
  }
  if (attach.kind === 'above') {
    return pDef.stackTop && cDef.stackBottom && !stackChild(craft, parentId, 'above');
  }
  return pDef.radialParent && cDef.radialChild;
}

export function addPart(
  craft: Craft,
  parentId: string,
  defId: string,
  attach: Attach,
  symmetry = 1,
): CraftPart {
  const part: CraftPart = { id: freshId(), defId, parentId, attach, symmetry };
  craft.parts[part.id] = part;
  return part;
}

/** Remove a part and its whole subtree. */
export function removePart(craft: Craft, id: string): void {
  if (id === craft.rootId) return;
  for (const c of children(craft, id)) removePart(craft, c.id);
  delete craft.parts[id];
}

/**
 * Remove ONE part, splicing the stack chain: whatever hung below the
 * removed part re-attaches to the part above it (always compatible — the
 * same faces were already mated through the removed part). Radial children
 * sit on the removed part's surface and have nowhere to go, so they are
 * removed with it. Returns the ids that were actually removed.
 */
export function removePartSplice(craft: Craft, id: string): string[] {
  const p = craft.parts[id];
  if (!p || id === craft.rootId) return [];
  // A radial part's stack children hang off ITS ring position — there is
  // no valid splice target, so the whole radial subtree goes.
  if (p.attach.kind === 'radial') {
    const ids = [id, ...subtreeIds(craft, id)];
    removePart(craft, id);
    return ids;
  }
  const removed: string[] = [];
  const below = stackChild(craft, id, 'below');
  for (const c of children(craft, id)) {
    if (c === below && p.parentId) continue; // spliced, not removed
    const before = Object.keys(craft.parts).length;
    removePart(craft, c.id);
    if (Object.keys(craft.parts).length < before) removed.push(c.id);
  }
  if (below && p.parentId) below.parentId = p.parentId;
  delete craft.parts[id];
  removed.push(id);
  return removed;
}

export interface Placement {
  part: CraftPart;
  def: PartDef;
  /** Effective axial height [m] — def.height, or the part's parametric
   * length for tanks. Renderers scale the mesh Y by height/def.height. */
  height: number;
  /** World transform per symmetry instance: x/z center, y of part bottom,
   * plus the instance angle around the vehicle axis. */
  instances: { x: number; y: number; z: number; angle: number }[];
}

/** Effective axial height of a part (parametric tanks override the def). */
export function partHeight(part: CraftPart, defn: PartDef): number {
  if (part.length !== undefined && defn.lengthRange) {
    return Math.min(defn.lengthRange.max, Math.max(defn.lengthRange.min, part.length));
  }
  return defn.height;
}

/**
 * Derive world placements for every part. Root sits with its bottom at the
 * stack's top; the assembly is then shifted so the lowest point rests at
 * y = 0 (the VAB floor).
 */
export function placements(craft: Craft): Map<string, Placement> {
  const out = new Map<string, Placement>();

  // First pass in root-local coordinates, root bottom at 0.
  const walk = (
    id: string,
    x: number,
    y: number,
    z: number,
    baseAngle: number,
    copies: { x: number; z: number; angle: number }[],
  ): void => {
    const part = craft.parts[id]!;
    const def = partById(part.defId);
    const h = partHeight(part, def);
    const inst = copies.map((c) => ({ x: x + c.x, y, z: z + c.z, angle: c.angle }));
    out.set(id, { part, def, height: h, instances: inst });

    for (const child of children(craft, id)) {
      const cDef = partById(child.defId);
      const cH = partHeight(child, cDef);
      if (child.attach.kind === 'below') {
        let cCopies = copies;
        // Engine cluster: n nozzles in a ring (plus center when it fits).
        if (cDef.kind === 'engine' && child.symmetry > 1) {
          const n = child.symmetry;
          const onRing = n >= 8 ? n - 1 : n;
          const ringR = Math.max(cDef.maxRadius * 1.05, def.radiusBottom - cDef.maxRadius - 0.08);
          const local: { dx: number; dz: number }[] = [];
          for (let k = 0; k < onRing; k++) {
            const a = (2 * Math.PI * k) / onRing;
            local.push({ dx: Math.cos(a) * ringR, dz: Math.sin(a) * ringR });
          }
          if (onRing < n) local.push({ dx: 0, dz: 0 });
          cCopies = copies.flatMap((c) =>
            local.map((l) => ({
              x: c.x + Math.cos(c.angle) * l.dx - Math.sin(c.angle) * l.dz,
              z: c.z + Math.sin(c.angle) * l.dx + Math.cos(c.angle) * l.dz,
              angle: c.angle,
            })),
          );
        }
        walk(child.id, x, y - cH, z, baseAngle, cCopies);
      } else if (child.attach.kind === 'above') {
        walk(child.id, x, y + h, z, baseAngle, copies);
      } else {
        // Radial: n instances around the parent's axis. Bodies stand off
        // side-by-side; fins mount flush; fairing shells sit centered
        // around the stack. Wings are the PAIR: one instance centered on
        // the axis at the fixed mirror azimuth (±90° — spanwise is
        // out-of-plane in the planar sim), wherever the drag dropped it.
        const pr = radiusAt(def, child.attach.y);
        const dist = cDef.fin ? pr : cDef.fairing || cDef.wing ? 0 : pr + cDef.maxRadius;
        const newCopies: { x: number; z: number; angle: number }[] = [];
        for (const c of copies) {
          for (let k = 0; k < child.symmetry; k++) {
            const a = cDef.wing
              ? Math.PI / 2 + c.angle
              : child.attach.angle + (2 * Math.PI * k) / child.symmetry + c.angle;
            // Instance angle = its own azimuth (orients fin meshes outward).
            newCopies.push({ x: c.x + Math.cos(a) * dist, z: c.z + Math.sin(a) * dist, angle: a });
          }
        }
        // Center the radial child's own segments about its attach height;
        // fairing shells grow upward from their mount ring instead.
        const cy = cDef.fairing ? y + child.attach.y : y + child.attach.y - cH / 2;
        walk(child.id, x, cy, z, baseAngle, newCopies);
      }
    }
  };
  walk(craft.rootId, 0, 0, 0, 0, [{ x: 0, z: 0, angle: 0 }]);

  // Shift so the lowest point is at y = 0.
  let minY = Infinity;
  for (const p of out.values()) for (const i of p.instances) minY = Math.min(minY, i.y);
  for (const p of out.values()) for (const i of p.instances) i.y -= minY;
  return out;
}

/**
 * Re-root the subtree hanging under a release pylon as its own Craft —
 * what the released vessel compiles from. The pylon itself is NOT
 * included (it stays with the carrier). Class defaults to rocket: the
 * released stack flies on its own merits, not the carrier's wings.
 */
export function subCraftFrom(craft: Craft, pylonId: string): Craft {
  const child = children(craft, pylonId).find((c) => c.attach.kind === 'below');
  if (!child) throw new Error('release pylon has nothing attached');
  const parts: Record<string, CraftPart> = {};
  // subtreeIds lists DESCENDANTS only — the new root is added explicitly.
  for (const id of [child.id, ...subtreeIds(craft, child.id)]) parts[id] = { ...craft.parts[id]! };
  parts[child.id] = { ...parts[child.id]!, parentId: null, attach: { kind: 'below' } };
  return { name: `${craft.name} payload`, rootId: child.id, parts, stageOrder: [] };
}

/** Total instance count for a part (its own symmetry times every radial
 * symmetry on the path to the root). */
export function instanceCount(craft: Craft, id: string): number {
  let n = 1;
  let p: CraftPart | undefined = craft.parts[id];
  while (p) {
    if (p.attach.kind === 'radial' || partById(p.defId).kind === 'engine') n *= p.symmetry;
    p = p.parentId ? craft.parts[p.parentId] : undefined;
  }
  return n;
}

// ---------- persistence ----------

export function serialize(craft: Craft): string {
  return JSON.stringify(craft);
}

export function deserialize(json: string): Craft {
  return JSON.parse(json) as Craft;
}
