// Ray picking against parts: every part is a stack of frustums around a
// vertical axis, so intersection is a quadratic per segment.

import { V3 } from './mat4';
import { Segment } from './mesh';

export interface Hit {
  t: number; // ray parameter
  y: number; // world y of the hit
  angle: number; // atan2(z - cz, x - cx) around the part axis
}

/**
 * Ray vs a vertical frustum stack centered at (cx, cz), each segment's
 * world y-range [y0, y1] with radii r0→r1. Returns the nearest hit.
 */
export function rayFrustums(
  origin: V3,
  dir: V3,
  cx: number,
  cz: number,
  segments: { y0: number; y1: number; r0: number; r1: number }[],
): Hit | null {
  let best: Hit | null = null;
  const qx = origin.x - cx;
  const qz = origin.z - cz;
  for (const seg of segments) {
    const h = seg.y1 - seg.y0 || 1e-9;
    const s = (seg.r1 - seg.r0) / h; // dr/dy
    // radius along the ray: r(t) = a + b·t
    const a = seg.r0 + (origin.y - seg.y0) * s;
    const b = dir.y * s;
    const A = dir.x * dir.x + dir.z * dir.z - b * b;
    const B = 2 * (qx * dir.x + qz * dir.z - a * b);
    const C = qx * qx + qz * qz - a * a;
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of Math.abs(A) < 1e-12 ? [-C / B] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
      if (t <= 0 || (best && t >= best.t)) continue;
      const y = origin.y + dir.y * t;
      if (y < seg.y0 || y > seg.y1) continue;
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      best = { t, y, angle: Math.atan2(pz - cz, px - cx) };
    }
  }
  return best;
}

/** Ray vs the ground plane y = 0 (returns t or null). */
export function rayGround(origin: V3, dir: V3): number | null {
  if (Math.abs(dir.y) < 1e-9) return null;
  const t = -origin.y / dir.y;
  return t > 0 ? t : null;
}
