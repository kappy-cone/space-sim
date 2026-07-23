// Minimal column-major mat4 + vec3 helpers — just what the VAB renderer
// needs (perspective, lookAt, model transforms). Float64 on the JS side;
// only the final upload to the GPU narrows to Float32.

export type Mat4 = Float64Array; // 16, column-major
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const addV = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const subV = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scaleV = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
export const dotV = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const crossV = (a: V3, b: V3): V3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const lenV = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const normV = (a: V3): V3 => {
  const l = lenV(a) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
};

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Rotation about the Y axis (the only rotation the VAB needs — parts are
 * bodies of revolution with vertical axes). */
export function rotationY(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/** Rotation about the Z axis. */
export function rotationZ(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

export function scaling(s: number): Mat4 {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  return m;
}

export function scalingXYZ(sx: number, sy: number, sz: number): Mat4 {
  const m = identity();
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye: V3, target: V3, up: V3): Mat4 {
  const z = normV(subV(eye, target));
  const x = normV(crossV(up, z));
  const y = crossV(z, x);
  const m = identity();
  m[0] = x.x;
  m[4] = x.y;
  m[8] = x.z;
  m[1] = y.x;
  m[5] = y.y;
  m[9] = y.z;
  m[2] = z.x;
  m[6] = z.y;
  m[10] = z.z;
  m[12] = -dotV(x, eye);
  m[13] = -dotV(y, eye);
  m[14] = -dotV(z, eye);
  return m;
}

export function toF32(m: Mat4): Float32Array {
  return Float32Array.from(m);
}
