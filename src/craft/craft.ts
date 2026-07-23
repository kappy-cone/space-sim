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
}

export interface Craft {
  name: string;
  parts: Record<string, CraftPart>;
  rootId: string;
  /** Stage firing order as section indices (see compile.ts); reordered
   * by the staging list UI. */
  stageOrder: number[];
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
 * the compile test suite. */
export function starterCrafts(): { name: string; craft: Craft }[] {
  // Heavy lifter: reference core + 3 symmetric boosters with nose cones.
  const heavy = referenceCraft();
  heavy.name = 'Heavy Lifter';
  const B = (id: string, defId: string, parentId: string, attach: Attach, symmetry = 1): void => {
    heavy.parts[id] = { id, defId, parentId, attach, symmetry };
  };
  B('rb', 't24-m', 's1tank', { kind: 'radial', angle: 0.4, y: 4 }, 3);
  B('rbe', 'e-merlin-1d', 'rb', { kind: 'below' });
  B('rbn', 'nose-24', 'rb', { kind: 'above' });

  // Recovery capsule: reference stack + drogue & main chutes on the pod —
  // orbit up, deorbit, and splash down inside the chute touchdown limits.
  const recovery = referenceCraft();
  recovery.name = 'Recovery Capsule';
  recovery.parts['drogue'] = {
    id: 'drogue',
    defId: 'chute-drogue',
    parentId: 'root',
    attach: { kind: 'radial', angle: 0.9, y: 1.5 },
    symmetry: 1,
  };
  recovery.parts['main'] = {
    id: 'main',
    defId: 'chute-main',
    parentId: 'root',
    attach: { kind: 'radial', angle: 2.9, y: 1.5 },
    symmetry: 1,
  };

  // Powered lander demo: probe + tank + Rutherford pair + legs + drogue.
  const lander: Craft = {
    name: 'Test Lander',
    rootId: 'root',
    stageOrder: [],
    parts: {},
  };
  const L = (id: string, defId: string, parentId: string | null, attach: Attach, symmetry = 1): void => {
    lander.parts[id] = { id, defId, parentId, attach, symmetry };
  };
  L('root', 'probe', null, { kind: 'below' });
  L('tank', 't12-s', 'root', { kind: 'below' });
  L('eng', 'e-rutherford', 'tank', { kind: 'below' }, 2);
  L('legs', 'leg-s', 'tank', { kind: 'radial', angle: 0.3, y: 0.8 }, 4);
  L('fins', 'fin-m', 'tank', { kind: 'radial', angle: 1.1, y: 0.8 }, 8);

  // Escape Probe: a third RL10 stage on the reference lower stack —
  // enough Δv to leave Earth orbit entirely (escape needs ~12.6 km/s
  // ideal from the surface: ~9.4 to LEO + ~3.2 more to C3 = 0).
  const escape: Craft = { name: 'Escape Probe', rootId: 'root', stageOrder: [], parts: {} };
  const E = (id: string, defId: string, parentId: string | null, attach: Attach, symmetry = 1): void => {
    escape.parts[id] = { id, defId, parentId, attach, symmetry };
  };
  E('root', 'probe', null, { kind: 'below' });
  E('s3tank', 't24-s', 'root', { kind: 'below' });
  E('s3eng', 'e-rl10b2', 's3tank', { kind: 'below' });
  E('dec3', 'dec-24', 's3eng', { kind: 'below' });
  E('s2tank', 't37-m', 'dec3', { kind: 'below' });
  E('s2eng', 'e-merlin-vac', 's2tank', { kind: 'below' });
  E('dec2', 'dec-37', 's2eng', { kind: 'below' });
  E('s1tank', 't37-xl', 'dec2', { kind: 'below' });
  E('s1eng', 'e-merlin-1d', 's1tank', { kind: 'below' }, 9);
  E('fins', 'fin-l', 's1tank', { kind: 'radial', angle: Math.PI / 8, y: 1.3 }, 8);

  return [
    { name: 'Reference Orbiter', craft: referenceCraft() },
    { name: 'Heavy Lifter', craft: heavy },
    { name: 'Recovery Capsule', craft: recovery },
    { name: 'Test Lander', craft: lander },
    { name: 'Escape Probe', craft: escape },
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
  /** World transform per symmetry instance: x/z center, y of part bottom,
   * plus the instance angle around the vehicle axis. */
  instances: { x: number; y: number; z: number; angle: number }[];
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
    const inst = copies.map((c) => ({ x: x + c.x, y, z: z + c.z, angle: c.angle }));
    out.set(id, { part, def, instances: inst });

    for (const child of children(craft, id)) {
      const cDef = partById(child.defId);
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
        walk(child.id, x, y - cDef.height, z, baseAngle, cCopies);
      } else if (child.attach.kind === 'above') {
        walk(child.id, x, y + def.height, z, baseAngle, copies);
      } else {
        // Radial: n instances around the parent's axis. Bodies stand off
        // side-by-side; fins mount flush on the surface.
        const pr = radiusAt(def, child.attach.y);
        const dist = cDef.fin ? pr : pr + cDef.maxRadius;
        const newCopies: { x: number; z: number; angle: number }[] = [];
        for (const c of copies) {
          for (let k = 0; k < child.symmetry; k++) {
            const a = child.attach.angle + (2 * Math.PI * k) / child.symmetry + c.angle;
            // Instance angle = its own azimuth (orients fin meshes outward).
            newCopies.push({ x: c.x + Math.cos(a) * dist, z: c.z + Math.sin(a) * dist, angle: a });
          }
        }
        // Center the radial child's own segments about its attach height.
        walk(child.id, x, y + child.attach.y - cDef.height / 2, z, baseAngle, newCopies);
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
