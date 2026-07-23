// Minimal 2D vector math. Plain objects, no classes — keeps the physics
// functions pure and the whole thing trivially serializable.

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
// z-component of the 3D cross product — signed angular momentum in the plane.
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const norm = (a: Vec2): number => Math.hypot(a.x, a.y);
export const unit = (a: Vec2): Vec2 => {
  const n = norm(a);
  return n === 0 ? { x: 0, y: 0 } : { x: a.x / n, y: a.y / n };
};
// Counterclockwise perpendicular (rotate +90°).
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const fromAngle = (theta: number): Vec2 => ({ x: Math.cos(theta), y: Math.sin(theta) });
