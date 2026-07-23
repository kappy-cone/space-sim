// One-off build-time OBJ -> binary glTF (.glb) converter. NOT a runtime
// dependency — it produces the committed asset from the CC0 source OBJ.
const fs = require('fs');
const [objPath, outPath] = process.argv.slice(2);
const txt = fs.readFileSync(objPath, 'utf8');
const V = [], N = [], keyMap = new Map();
const positions = [], normals = [], indices = [];
const relV = (i) => (i < 0 ? V.length + i : i - 1);
const relN = (i) => (i < 0 ? N.length + i : i - 1);
for (const line of txt.split('\n')) {
  const t = line.trim();
  if (t.startsWith('v ')) { const a = t.split(/\s+/); V.push([+a[1], +a[2], +a[3]]); }
  else if (t.startsWith('vn ')) { const a = t.split(/\s+/); N.push([+a[1], +a[2], +a[3]]); }
  else if (t.startsWith('f ')) {
    const toks = t.split(/\s+/).slice(1).map((tok) => {
      const p = tok.split('/'); return { v: parseInt(p[0], 10), vn: p[2] ? parseInt(p[2], 10) : 0 };
    });
    for (let i = 1; i + 1 < toks.length; i++) {
      for (const tk of [toks[0], toks[i], toks[i + 1]]) {
        const key = tk.v + '|' + tk.vn;
        let idx = keyMap.get(key);
        if (idx === undefined) {
          idx = positions.length / 3; keyMap.set(key, idx);
          const p = V[relV(tk.v)]; positions.push(p[0], p[1], p[2]);
          if (tk.vn) { const n = N[relN(tk.vn)]; normals.push(n[0], n[1], n[2]); } else normals.push(0, 1, 0);
        }
        indices.push(idx);
      }
    }
  }
}
const vc = positions.length / 3, ic = indices.length;
if (vc > 65535) throw new Error('too many verts for uint16: ' + vc);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < vc; i++) for (let k = 0; k < 3; k++) { const x = positions[i * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
const posBytes = vc * 12, nrmBytes = vc * 12, idxBytes = ic * 2;
const pad = (n) => (4 - (n % 4)) % 4;
const idxPad = pad(idxBytes);
const binLen = posBytes + nrmBytes + idxBytes + idxPad;
const bin = Buffer.alloc(binLen);
for (let i = 0; i < vc * 3; i++) { bin.writeFloatLE(positions[i], i * 4); bin.writeFloatLE(normals[i], posBytes + i * 4); }
for (let i = 0; i < ic; i++) bin.writeUInt16LE(indices[i], posBytes + nrmBytes + i * 2);
const json = {
  asset: { version: '2.0', generator: 'obj2glb (space-sim)' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }] }],
  buffers: [{ byteLength: binLen }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes },
    { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes },
    { buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: idxBytes },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: vc, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: vc, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: ic, type: 'SCALAR' },
  ],
};
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jpad = pad(jsonBuf.length); if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]);
const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
const out = Buffer.alloc(total); let p = 0;
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8); p = 12;
out.writeUInt32LE(jsonBuf.length, p); out.writeUInt32LE(0x4e4f534a, p + 4); jsonBuf.copy(out, p + 8); p += 8 + jsonBuf.length;
out.writeUInt32LE(bin.length, p); out.writeUInt32LE(0x004e4942, p + 4); bin.copy(out, p + 8);
fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${vc} verts, ${ic/3} tris, ${(total/1024).toFixed(0)} KB`);
