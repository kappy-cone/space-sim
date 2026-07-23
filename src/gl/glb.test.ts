// The .glb loader, validated against hand-built binary glTF containers —
// no external files needed. Covers node transforms, indexed geometry,
// vertex colors, and malformed-input rejection.

import { describe, expect, it } from 'vitest';
import { glbToMesh, parseGlb } from './glb';

/** Assemble a .glb container from a glTF JSON object + a binary blob. */
function buildGlb(json: object, bin: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const pad = (n: number): number => (4 - (n % 4)) % 4;
  // Pad JSON with spaces, BIN with zeros, to 4-byte alignment.
  const jsonPad = pad(jsonBytes.length);
  const jsonChunk = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
  jsonChunk.set(jsonBytes);
  const binPad = pad(bin.length);
  const binChunk = new Uint8Array(bin.length + binPad);
  binChunk.set(bin);

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let p = 12;
  dv.setUint32(p, jsonChunk.length, true);
  dv.setUint32(p + 4, 0x4e4f534a, true); // 'JSON'
  u8.set(jsonChunk, p + 8);
  p += 8 + jsonChunk.length;
  dv.setUint32(p, binChunk.length, true);
  dv.setUint32(p + 4, 0x004e4942, true); // 'BIN\0'
  u8.set(binChunk, p + 8);
  return buf;
}

/** One triangle: positions, normals, ushort indices, packed contiguously. */
function triangleBin(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = new Uint8Array(36 + 36 + 8); // indices padded to 8
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(normals.buffer), 36);
  bin.set(new Uint8Array(indices.buffer), 72);
  return bin;
}

const TRI_GLTF = {
  buffers: [{ byteLength: 80 }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 36 },
    { buffer: 0, byteOffset: 72, byteLength: 6 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
    { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }] }],
  scenes: [{ nodes: [0] }],
  scene: 0,
};

describe('glb loader', () => {
  it('applies a node translation to positions (and leaves normals unit)', () => {
    const json = { ...TRI_GLTF, nodes: [{ mesh: 0, translation: [10, 0, 0] }] };
    const mesh = glbToMesh(buildGlb(json, triangleBin()));
    expect([...mesh.positions]).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
    expect([...mesh.normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect([...mesh.indices]).toEqual([0, 1, 2]);
    expect(mesh.colors).toBeUndefined();
  });

  it('applies a node scale via a matrix and transforms normals', () => {
    // Column-major matrix: scale x by 2, y by 3.
    const json = {
      ...TRI_GLTF,
      nodes: [{ mesh: 0, matrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    };
    const mesh = glbToMesh(buildGlb(json, triangleBin()));
    expect([...mesh.positions]).toEqual([0, 0, 0, 2, 0, 0, 0, 3, 0]);
    // Normal (0,0,1) is unaffected by an x/y scale, stays unit +z.
    expect(mesh.normals[2]).toBeCloseTo(1, 6);
  });

  it('reads normalized ubyte COLOR_0 as vec3, dropping alpha', () => {
    // Add a COLOR_0 accessor (VEC4 ubyte normalized) after the indices.
    const bin = new Uint8Array(80 + 16); // 3 verts × 4 bytes = 12, pad to 16
    bin.set(triangleBin(), 0);
    bin.set(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), 80);
    const json = {
      ...TRI_GLTF,
      buffers: [{ byteLength: 96 }],
      bufferViews: [...TRI_GLTF.bufferViews, { buffer: 0, byteOffset: 80, byteLength: 12 }],
      accessors: [
        ...TRI_GLTF.accessors,
        { bufferView: 3, componentType: 5121, count: 3, type: 'VEC4', normalized: true },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 3 }, indices: 2, mode: 4 }] }],
      nodes: [{ mesh: 0 }],
    };
    const mesh = glbToMesh(buildGlb(json, bin));
    expect(mesh.colors).toBeDefined();
    expect([...mesh.colors!]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]); // rgb, no alpha
  });

  it('parses container chunks and rejects a non-glb', () => {
    const { json, bin } = parseGlb(buildGlb({ ...TRI_GLTF, nodes: [{ mesh: 0 }] }, triangleBin()));
    expect(json.meshes?.length).toBe(1);
    expect(bin.byteLength).toBe(80);
    expect(() => parseGlb(new Uint8Array([1, 2, 3, 4]).buffer)).toThrow();
  });
});
