// Orbit camera: yaw/pitch around a target point, wheel zoom, vertical pan.

import { Mat4, V3, crossV, lookAt, normV, perspective, subV, v3 } from './mat4';

export class OrbitCamera {
  yaw = 0.6; // rad
  pitch = 0.25; // rad above horizon
  dist = 18; // m
  minDist = 3;
  maxDist = 120;
  /** Wheel-zoom speed (exponent per deltaY unit). */
  zoomRate = 0.0035;
  target: V3 = v3(0, 6, 0);

  attach(el: HTMLElement, onChange: () => void): void {
    let dragging = false;
    let panning = false;
    let lx = 0;
    let ly = 0;
    el.addEventListener('mousedown', (e) => {
      // The VAB claims left-drag on parts; camera takes unclaimed drags.
      if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
      dragging = e.button === 0 && !e.shiftKey;
      panning = e.button === 1 || (e.button === 0 && e.shiftKey);
      lx = e.clientX;
      ly = e.clientY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging && !panning) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (dragging) {
        this.yaw -= dx * 0.008;
        this.pitch = Math.min(1.45, Math.max(-1.45, this.pitch + dy * 0.008));
      } else {
        this.target = v3(this.target.x, Math.max(0, this.target.y + dy * 0.02 * (this.dist / 18)), this.target.z);
      }
      onChange();
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      panning = false;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist * Math.exp(e.deltaY * this.zoomRate)));
        onChange();
      },
      { passive: false },
    );
  }

  eye(): V3 {
    return v3(
      this.target.x + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target.y + this.dist * Math.sin(this.pitch),
      this.target.z + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
    );
  }

  view(): Mat4 {
    return lookAt(this.eye(), this.target, v3(0, 1, 0));
  }

  /** Camera rotation only (for the renderer's camera-relative pipeline). */
  viewRot(): Mat4 {
    const eye = this.eye();
    return lookAt(v3(0, 0, 0), subV(this.target, eye), v3(0, 1, 0));
  }

  proj(aspect: number, near = 0.1, far = 500): Mat4 {
    return perspective(Math.PI / 4, aspect, near, far);
  }

  /** World-space ray through a canvas pixel (for picking). */
  ray(px: number, py: number, w: number, h: number): { origin: V3; dir: V3 } {
    const eye = this.eye();
    const fovY = Math.PI / 4;
    const cx = ((2 * px) / w - 1) * Math.tan(fovY / 2) * (w / h);
    const cy = (1 - (2 * py) / h) * Math.tan(fovY / 2);
    // Camera basis, matching lookAt(eye, target, +Y up).
    const z = normV(subV(eye, this.target));
    const x = normV(crossV(v3(0, 1, 0), z));
    const y = crossV(z, x);
    const dir = normV(
      v3(
        x.x * cx + y.x * cy - z.x,
        x.y * cx + y.y * cy - z.y,
        x.z * cx + y.z * cy - z.z,
      ),
    );
    return { origin: eye, dir };
  }
}
