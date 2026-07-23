// Minimal binary-glTF (.glb) mesh loader — zero dependencies, reads only
// what this renderer draws: POSITION, NORMAL, COLOR_0 and indices, with
// node transforms applied and all primitives merged into one MeshData.
//
// It is deliberately NOT a full glTF implementation: no textures, no
// materials, no skins/animation, no Draco. That is exactly the subset
// the one-shader renderer (gl/renderer.ts) can light, and it keeps the
// project's zero-runtime-dependency rule (glTF accessors are just typed-
// array views into one binary blob — no library needed). Reference:
// Khronos glTF 2.0 spec, §3.6 (accessors) and the GLB container layout.
//
// The input is EXTERNAL binary, so every offset/length is bounds-checked
// against the buffer — a malformed file throws, it never reads out of
// bounds.

import { MeshData } from './mesh';

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  material?: number;
}
interface Gltf {
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  meshes?: { primitives: GltfPrimitive[] }[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  /** Only the flat base colour is read — no textures, no PBR shading.
   * Kenney-style kits colour each part with a material baseColorFactor,
   * which the flat-shading renderer treats as a per-vertex colour. */
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[];
}

/** Split a .glb container into its JSON and binary chunks. */
export function parseGlb(buffer: ArrayBuffer): { json: Gltf; bin: ArrayBuffer } {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 12 || dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a .glb file');
  if (dv.getUint32(4, true) !== 2) throw new Error('unsupported glTF version (need 2)');
  const total = dv.getUint32(8, true);
  if (total > buffer.byteLength) throw new Error('.glb length header exceeds file');
  let json: Gltf | null = null;
  let bin: ArrayBuffer | null = null;
  let p = 12;
  while (p + 8 <= total) {
    const len = dv.getUint32(p, true);
    const type = dv.getUint32(p + 4, true);
    const start = p + 8;
    if (start + len > buffer.byteLength) throw new Error('.glb chunk overruns file');
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len))) as Gltf;
    else if (type === CHUNK_BIN) bin = buffer.slice(start, start + len);
    p = start + len + ((4 - (len % 4)) % 4); // chunks are 4-byte aligned
  }
  if (!json) throw new Error('.glb has no JSON chunk');
  return { json, bin: bin ?? new ArrayBuffer(0) };
}

/** Read an accessor as a flat number[] (component values, count×N). */
function readAccessor(json: Gltf, bin: ArrayBuffer, index: number): { data: number[]; comps: number } {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`missing accessor ${index}`);
  const comps = NUM_COMPONENTS[acc.type];
  const csize = COMPONENT_SIZE[acc.componentType];
  if (!comps || !csize) throw new Error(`unsupported accessor type ${acc.type}/${acc.componentType}`);
  const bv = json.bufferViews?.[acc.bufferView ?? -1];
  if (!bv) throw new Error('accessor without bufferView');
  const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : comps * csize;
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin);
  const out: number[] = [];
  for (let i = 0; i < acc.count; i++) {
    const rowStart = base + i * stride;
    for (let c = 0; c < comps; c++) {
      const off = rowStart + c * csize;
      if (off + csize > bin.byteLength) throw new Error('accessor reads past the binary chunk');
      let v: number;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(off, true); break;
        case 5125: v = dv.getUint32(off, true); break;
        case 5123: v = dv.getUint16(off, true); break;
        case 5121: v = dv.getUint8(off); break;
        case 5122: v = dv.getInt16(off, true); break;
        default: v = dv.getInt8(off); break;
      }
      if (acc.normalized) {
        if (acc.componentType === 5121) v /= 255;
        else if (acc.componentType === 5123) v /= 65535;
        else if (acc.componentType === 5120) v = Math.max(v / 127, -1);
        else if (acc.componentType === 5122) v = Math.max(v / 32767, -1);
      }
      out.push(v);
    }
  }
  return { data: out, comps };
}

// ---- 4×4 column-major matrix helpers (glTF convention) ----
type M16 = number[];
const IDENT: M16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M16, b: M16): M16 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}
function nodeMatrix(n: GltfNode): M16 {
  if (n.matrix && n.matrix.length === 16) return n.matrix.slice();
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  // Rotation matrix from quaternion (column-major).
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const applyPoint = (m: M16, x: number, y: number, z: number): [number, number, number] => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
];
const applyDir = (m: M16, x: number, y: number, z: number): [number, number, number] => [
  m[0]! * x + m[4]! * y + m[8]! * z,
  m[1]! * x + m[5]! * y + m[9]! * z,
  m[2]! * x + m[6]! * y + m[10]! * z,
];

/**
 * Merge every primitive of a .glb into a single MeshData in scene space
 * (node transforms applied). Positions and normals are world-transformed;
 * COLOR_0 is carried through as vec3 (alpha dropped) when present.
 */
export function glbToMesh(buffer: ArrayBuffer): MeshData {
  const { json, bin } = parseGlb(buffer);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let hasColor = false;
  let base = 0;

  const emitNode = (nodeIdx: number, parent: M16): void => {
    const node = json.nodes?.[nodeIdx];
    if (!node) return;
    const world = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      for (const prim of mesh?.primitives ?? []) {
        if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
        const posA = prim.attributes.POSITION;
        if (posA === undefined) continue;
        const pos = readAccessor(json, bin, posA);
        const vcount = pos.data.length / 3;
        const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(json, bin, prim.attributes.NORMAL).data : null;
        const col = prim.attributes.COLOR_0 !== undefined ? readAccessor(json, bin, prim.attributes.COLOR_0) : null;
        // Per-vertex colour takes precedence; otherwise the material's
        // flat base colour is applied to the whole primitive.
        const mat = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor : undefined;
        for (let i = 0; i < vcount; i++) {
          const wp = applyPoint(world, pos.data[i * 3]!, pos.data[i * 3 + 1]!, pos.data[i * 3 + 2]!);
          positions.push(wp[0], wp[1], wp[2]);
          if (nrm) {
            const wn = applyDir(world, nrm[i * 3]!, nrm[i * 3 + 1]!, nrm[i * 3 + 2]!);
            const m = Math.hypot(wn[0], wn[1], wn[2]) || 1;
            normals.push(wn[0] / m, wn[1] / m, wn[2] / m);
          } else {
            normals.push(0, 1, 0); // filled per-face below if no shading normals
          }
          if (col) {
            hasColor = true;
            colors.push(col.data[i * col.comps]!, col.data[i * col.comps + 1]!, col.data[i * col.comps + 2]!);
          } else if (mat) {
            hasColor = true;
            colors.push(mat[0] ?? 1, mat[1] ?? 1, mat[2] ?? 1);
          } else {
            colors.push(1, 1, 1);
          }
        }
        if (prim.indices !== undefined) {
          for (const idx of readAccessor(json, bin, prim.indices).data) indices.push(base + idx);
        } else {
          for (let i = 0; i < vcount; i++) indices.push(base + i);
        }
        base += vcount;
      }
    }
    for (const c of node.children ?? []) emitNode(c, world);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? json.nodes?.map((_, i) => i) ?? [];
  for (const r of roots) emitNode(r, IDENT);

  if (positions.length === 0) throw new Error('.glb contained no triangle geometry');
  if (base > 65535) throw new Error(`.glb has ${base} vertices — exceeds the 16-bit index limit`);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
    ...(hasColor ? { colors: new Float32Array(colors) } : {}),
  };
}

/** Fetch and parse a .glb at a URL into a MeshData. */
export async function loadGlbMesh(url: string): Promise<MeshData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`glb fetch ${url}: ${res.status}`);
  return glbToMesh(await res.arrayBuffer());
}
