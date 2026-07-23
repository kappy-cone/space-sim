// Procedural meshes: every part is a stack of frustum segments (a cylinder
// is a frustum with equal radii, a cone has rTop = 0). No asset pipeline.

export interface Segment {
  y0: number; // bottom of segment, part-local (part origin = bottom center)
  y1: number;
  r0: number; // radius at y0
  r1: number; // radius at y1
}

export interface MeshData {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
  /** Optional per-vertex color (multiplied with the draw color). */
  colors?: Float32Array<ArrayBuffer>;
}

const RADIAL_STEPS = 28;

/** Build one mesh from stacked frustum segments (smooth cylindrical
 * normals on the sides, flat caps at open ends). */
export function segmentsMesh(segments: Segment[]): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];

  const ring = (y: number, r: number, slope: number): number => {
    // slope = dr/dy; side normal tilts accordingly: n = (cosθ, -slope, sinθ)/|·|
    const base = pos.length / 3;
    for (let i = 0; i <= RADIAL_STEPS; i++) {
      const a = (i / RADIAL_STEPS) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pos.push(c * r, y, s * r);
      const nl = Math.hypot(1, slope);
      nrm.push(c / nl, -slope / nl, s / nl);
    }
    return base;
  };

  for (const seg of segments) {
    const slope = (seg.r1 - seg.r0) / (seg.y1 - seg.y0 || 1);
    const b0 = ring(seg.y0, seg.r0, slope);
    const b1 = ring(seg.y1, seg.r1, slope);
    for (let i = 0; i < RADIAL_STEPS; i++) {
      idx.push(b0 + i, b1 + i, b0 + i + 1, b0 + i + 1, b1 + i, b1 + i + 1);
    }
  }

  // Caps: bottom of first segment and top of last (if open).
  const cap = (y: number, r: number, up: boolean): void => {
    if (r <= 0) return;
    const center = pos.length / 3;
    pos.push(0, y, 0);
    nrm.push(0, up ? 1 : -1, 0);
    const base = pos.length / 3;
    for (let i = 0; i <= RADIAL_STEPS; i++) {
      const a = (i / RADIAL_STEPS) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      nrm.push(0, up ? 1 : -1, 0);
    }
    for (let i = 0; i < RADIAL_STEPS; i++) {
      if (up) idx.push(center, base + i + 1, base + i);
      else idx.push(center, base + i, base + i + 1);
    }
  };
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  cap(first.y0, first.r0, false);
  cap(last.y1, last.r1, true);

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint16Array(idx),
  };
}

/**
 * Trapezoidal fin: root chord cr (vertical, along y), tip chord ct at
 * x = span, tip leading edge swept down by `sweep`. Local origin at the
 * root trailing edge (bottom); +x points outward from the body.
 */
export function finMesh(cr: number, ct: number, span: number, sweep: number, thickness: number): MeshData {
  const t = thickness / 2;
  // Planform corners: root TE, root LE, tip LE, tip TE.
  const quad: [number, number][] = [
    [0, 0],
    [0, cr],
    [span, cr - sweep],
    [span, cr - sweep - ct],
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  // Two faces at ±t.
  for (const z of [t, -t]) {
    const base = pos.length / 3;
    for (const [x, y] of quad) {
      pos.push(x, y, z);
      nrm.push(0, 0, Math.sign(z));
    }
    if (z > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  // Edge strips (flat normals outward-ish; visually fine at this size).
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = quad[i]!;
    const [x1, y1] = quad[(i + 1) % 4]!;
    const ex = y1 - y0;
    const ey = -(x1 - x0);
    const el = Math.hypot(ex, ey) || 1;
    const base = pos.length / 3;
    pos.push(x0, y0, t, x0, y0, -t, x1, y1, t, x1, y1, -t);
    for (let k = 0; k < 4; k++) nrm.push(ex / el, ey / el, 0);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint16Array(idx),
  };
}

/** Unit lat-long sphere with the poles on ±z (the rotation axis of a body
 * whose equator lies in the world x-y plane). Optional per-vertex color
 * from (lat, lon) — used for terrain. */
export function sphereMesh(
  latBands = 48,
  lonBands = 72,
  colorFn?: (lat: number, lon: number) => [number, number, number],
): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latBands; i++) {
    const phi = (i / latBands) * Math.PI - Math.PI / 2; // -90..90
    for (let j = 0; j <= lonBands; j++) {
      const lam = (j / lonBands) * 2 * Math.PI;
      const x = Math.cos(phi) * Math.cos(lam);
      const y = Math.cos(phi) * Math.sin(lam);
      const z = Math.sin(phi);
      pos.push(x, y, z);
      nrm.push(x, y, z);
      if (colorFn) col.push(...colorFn(phi, lam));
    }
  }
  const row = lonBands + 1;
  for (let i = 0; i < latBands; i++) {
    for (let j = 0; j < lonBands; j++) {
      const a = i * row + j;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint16Array(idx),
    colors: colorFn ? new Float32Array(col) : undefined,
  };
}

/**
 * Terrain color for a unit-sphere point: deterministic layered sine noise
 * picks continents; visual only — collision stays the smooth sphere (the
 * landing brief froze terrain systems; this is paint, not topography).
 */
export function terrainColor(lat: number, lon: number): [number, number, number] {
  // Polar caps.
  if (Math.abs(lat) > 1.22) return [0.86, 0.9, 0.94];
  const n =
    Math.sin(3.1 * lat + 0.9) * Math.cos(2.3 * lon + 1.1) +
    0.55 * Math.sin(5.7 * lon + 2.0) * Math.cos(4.1 * lat) +
    0.35 * Math.sin(9.3 * lat + 6.1 * lon) +
    // Guaranteed landmass under the launch site (local lat 0, lon 90°).
    1.1 * Math.exp(-8 * (lat * lat + (lon - Math.PI / 2) ** 2));
  if (n > 1.05) return [0.55, 0.5, 0.38]; // highlands
  if (n > 0.45) return [0.28, 0.46, 0.25]; // lowlands
  if (n > 0.32) return [0.72, 0.68, 0.5]; // coast
  if (n > 0.0) return [0.1, 0.28, 0.5]; // shelf
  return [0.07, 0.2, 0.42]; // deep ocean
}

/**
 * Regolith paint for the moon: grey with darker maria patches. Same rules
 * as terrainColor — deterministic layered sine noise, visual only.
 */
export function moonColor(lat: number, lon: number): [number, number, number] {
  const n =
    Math.sin(2.1 * lat + 0.4) * Math.cos(3.3 * lon + 2.2) +
    0.6 * Math.sin(7.9 * lon + 1.0) * Math.cos(5.3 * lat + 0.7) +
    0.3 * Math.sin(11 * lat + 13 * lon);
  const g = n > 0.55 ? 0.34 : n > -0.2 ? 0.47 : 0.54; // maria / plains / highlands
  const j = 1 + 0.05 * Math.sin(23 * lat + 31 * lon); // fine grain
  return [g * j, g * j, g * j * 1.03];
}

/**
 * Local ground cap: a spherical-cap patch of body radius R, model origin at
 * the surface point, +y = local up. The global planet sphere's model origin
 * is the body center, so its MVP picks up float32 quantization ~0.5 m at
 * Earth scale — enough to make near-field terrain jitter and z-fight the
 * launch pad every frame. This cap is anchored at the surface (small
 * camera-relative translation → stable) and follows the true sphere
 * (y = −(R − √(R²−ρ²))), sitting `sink` metres below the datum so the pad
 * deck stays proud of it.
 */
export function groundCapMesh(R: number, radius: number, sink: number, rings = 24, segs = 48): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    // Quadratic ring spacing: fine near the pad, coarse at the rim.
    const rho = radius * (i / rings) ** 2;
    const y = -(R - Math.sqrt(Math.max(0, R * R - rho * rho))) - sink;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * 2 * Math.PI;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pos.push(c * rho, y, s * rho);
      // True sphere normal: direction from the body center (0, −R, 0).
      const nl = Math.hypot(c * rho, y + R, s * rho) || 1;
      nrm.push((c * rho) / nl, (y + R) / nl, (s * rho) / nl);
      // Subtle deterministic mottling (±6% brightness): a featureless
      // ground gives no motion parallax, which made descents feel static.
      const b = 1 + 0.06 * Math.sin(9.7 * (i / rings) + 0.5) * Math.cos(5 * a + 1.3);
      col.push(b, b, b);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint16Array(idx),
    colors: new Float32Array(col),
  };
}

/** Ground grid lines mesh (positions only, drawn unlit as GL_LINES). */
export function gridMesh(half: number, step: number): Float32Array {
  const lines: number[] = [];
  for (let i = -half; i <= half; i += step) {
    lines.push(i, 0, -half, i, 0, half);
    lines.push(-half, 0, i, half, 0, i);
  }
  return new Float32Array(lines);
}
