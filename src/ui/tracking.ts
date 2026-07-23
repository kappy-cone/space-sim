// The Program view: everything the player has put in the world, on one
// screen — registry objects by type and age, ground-network coverage,
// terrain reveal, altitude-band congestion, the mission board, and the
// world clock (which only ever moves forward here or through committed
// flights). Rendering is a plain 2D canvas redrawn on demand; nothing
// animates and nothing polls.

import { EARTH, bodyById, bodyOrbitState } from '../physics/bodies';
import { SITES } from '../physics/sites';
import { fmtDistance, fmtTime } from './format';
import { tickMissions } from '../world/missions';
import { GROUND_STATIONS, hasLink, stationPos } from '../world/network';
import {
  REVEAL_BINS,
  WorldState,
  advanceWorld,
  congestion,
  isRevealed,
  objectElements,
  objectStateAt,
  revealedFraction,
  siteState,
} from '../world/world';

export class TrackingView {
  private veil: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private panel!: HTMLElement;
  /** View scale [m per px] — wheel zooms. */
  private mPerPx = 0;

  constructor(
    private root: HTMLElement,
    private world: WorldState,
    private saveWorld: () => void,
  ) {
    this.veil = document.createElement('div');
    this.veil.className = 'modal-veil';
    this.veil.onclick = (e) => {
      if (e.target === this.veil) this.close();
    };
    const box = document.createElement('div');
    box.className = 'panel modal tracking';
    this.veil.appendChild(box);

    const left = document.createElement('div');
    left.className = 'tracking-map';
    this.canvas = document.createElement('canvas');
    left.appendChild(this.canvas);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.mPerPx *= e.deltaY > 0 ? 1.25 : 0.8;
      this.draw();
    });
    this.panel = document.createElement('div');
    this.panel.className = 'tracking-side';
    box.append(left, this.panel);
    root.appendChild(this.veil);
    this.renderPanel();
    this.draw();
  }

  close(): void {
    this.veil.remove();
  }

  private advance(seconds: number): void {
    advanceWorld(this.world, seconds);
    tickMissions(this.world);
    this.saveWorld();
    this.renderPanel();
    this.draw();
  }

  // ---------- right panel ----------

  private renderPanel(): void {
    const w = this.world;
    const open = w.missions.filter((m) => m.status === 'open');
    const settled = w.missions.filter((m) => m.status !== 'open');
    const bands = congestion(w);
    const maxBand = Math.max(1, ...bands);
    const bandRows = bands
      .map((n, i) => ({ n, i }))
      .filter((b) => b.n > 0)
      .map(
        (b) =>
          `<div class="band-row"><span>${b.i * 100}–${(b.i + 1) * 100} km</span>` +
          `<span class="band-bar"><i style="width:${(100 * b.n) / maxBand}%"></i></span><span>${b.n}</span></div>`,
      )
      .join('');
    const objects = [...w.objects].sort((a, b) => b.launch - a.launch || a.id.localeCompare(b.id));
    const objRows = objects
      .map((o) => {
        const el = objectElements(o);
        const kindTxt = o.func ?? o.kind;
        const R = bodyById(o.body).radius;
        const orbitTxt =
          el.e < 1
            ? `${Math.round((el.rPeri - R) / 1000)}×${Math.round((el.rApo - R) / 1000)} km${el.h < 0 ? ' ↺' : ''}`
            : 'escape';
        const ageDays = ((w.epoch - (o.born ?? o.t0)) / 86_400).toFixed(1);
        const moon = o.body === 'moon' ? ' ⦿Luna' : '';
        return `<div class="obj-row"><b class="k-${o.kind}${o.func ? ` f-${o.func}` : ''}">${kindTxt}</b>` +
          `<span>${o.name}${moon}${o.illegal ? ' ⚑' : ''}</span><span>${orbitTxt}</span>` +
          `<span>${ageDays} d${o.skProp > 1 ? ` · sk ${o.skProp.toFixed(0)} kg` : ''}</span></div>`;
      })
      .join('');
    const missionRow = (m: (typeof w.missions)[number]): string => {
      const left = m.deadline - w.epoch;
      const cls = m.status === 'done' ? 'good' : m.status === 'expired' ? 'bad' : left < 10 * 86_400 ? 'warn' : '';
      const tail =
        m.status === 'open' ? `${Math.max(0, Math.floor(left / 86_400))} d left` : m.status;
      return `<div class="mission-row ${cls}"><span>${m.title}</span><span>${tail}</span></div>`;
    };
    const logRows = [...w.log]
      .slice(-8)
      .reverse()
      .map((e) => {
        const txt =
          e.type === 'launch'
            ? `Launch #${e.n} — ${e.name} (${e.site})`
            : e.type === 'deployed'
              ? `Deployed ${e.name}${e.func ? ` [${e.func}]` : ''}`
              : e.type === 'debris'
                ? `Debris on orbit: ${e.name}`
                : e.type === 'reentry'
                  ? `Reentered: ${e.name}`
                  : e.type === 'deorbited'
                    ? `Deorbited: ${e.name}`
                    : e.type === 'recovered'
                      ? `Recovered: ${e.name}`
                      : e.type === 'skDepleted'
                        ? `Station-keeping dry: ${e.name}`
                        : e.type === 'siteDiscovered'
                          ? `Site discovered: ${e.site}`
                          : e.type === 'siteActivated'
                            ? `Site activated: ${e.site}`
                            : e.type === 'rangeViolation'
                              ? `RANGE VIOLATION at ${e.site}`
                              : e.type === 'missionComplete'
                                ? `✓ ${e.title}`
                                : e.type === 'missionExpired'
                                  ? `✗ lapsed: ${e.title}`
                                  : 'event'; // exhaustive above
        return `<div class="log-row">T ${fmtTime(e.t)} · ${txt}</div>`;
      })
      .join('');

    this.panel.innerHTML = `
      <h3>Program <button class="mini close-btn" style="float:right">✕</button></h3>
      <div class="track-clock">World clock <b>T ${fmtTime(this.world.epoch)}</b> · ${this.world.launches} launch${this.world.launches === 1 ? '' : 'es'} ·
        terrain ${(revealedFraction(this.world) * 100).toFixed(0)}% mapped</div>
      <div class="track-advance">Advance:
        <button data-dt="${6 * 3600}">+6 h</button>
        <button data-dt="${86_400}">+1 d</button>
        <button data-dt="${10 * 86_400}">+10 d</button>
      </div>
      <h3>Missions</h3>
      ${open.map(missionRow).join('') || '<div class="log-row">the world is content — fly something</div>'}
      ${settled.length > 0 ? `<details><summary>${settled.length} settled</summary>${settled.map(missionRow).join('')}</details>` : ''}
      <h3>On orbit (${this.world.objects.length})</h3>
      <div class="obj-list">${objRows || '<div class="log-row">nothing yet — commit a launch</div>'}</div>
      ${bandRows ? `<h3>Congestion (100 km bands)</h3>${bandRows}` : ''}
      <h3>Log</h3>
      ${logRows || '<div class="log-row">quiet so far</div>'}`;
    this.panel.querySelector<HTMLButtonElement>('.close-btn')!.onclick = () => this.close();
    this.panel.querySelectorAll<HTMLButtonElement>('.track-advance button').forEach((b) => {
      b.onclick = () => this.advance(Number(b.dataset.dt));
    });
  }

  // ---------- map ----------

  private draw(): void {
    const w = this.world;
    const t = w.epoch;
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth || 640;
    const ch = this.canvas.clientHeight || 560;
    this.canvas.width = cw * dpr;
    this.canvas.height = ch * dpr;
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#070b14';
    g.fillRect(0, 0, cw, ch);

    // Default scale: fit the largest orbit (at least 3 Earth radii).
    if (this.mPerPx === 0) {
      let rMax = 3 * EARTH.radius;
      for (const o of w.objects) {
        if (o.body !== 'earth') continue;
        const el = objectElements(o);
        if (el.e < 1) rMax = Math.max(rMax, el.rApo * 1.1);
      }
      this.mPerPx = (2 * rMax) / Math.min(cw, ch);
    }
    const cx = cw / 2;
    const cy = ch / 2;
    const px = (x: number, y: number): [number, number] => [cx + x / this.mPerPx, cy - y / this.mPerPx];
    const Rpx = EARTH.radius / this.mPerPx;

    // Terrain: revealed arcs in terrain green, the unknown dark. The
    // surface rotates; bins are surface-fixed, so spin them to now.
    const spin = EARTH.rotationRate * t;
    for (let i = 0; i < REVEAL_BINS; i += 4) {
      const a0 = (i / REVEAL_BINS) * 2 * Math.PI;
      const a1 = ((i + 4) / REVEAL_BINS) * 2 * Math.PI;
      g.beginPath();
      g.moveTo(cx, cy);
      // Canvas y is flipped; use -angle to keep east counterclockwise.
      g.arc(cx, cy, Math.max(Rpx, 2), -(a0 + spin), -(a1 + spin), true);
      g.closePath();
      g.fillStyle = isRevealed(w, a0) ? '#1e3a2a' : '#151a26';
      g.fill();
    }
    g.beginPath();
    g.arc(cx, cy, Math.max(Rpx, 2), 0, 2 * Math.PI);
    g.strokeStyle = '#2a3554';
    g.stroke();

    // Ground-network coverage: the surface arcs where a 300 km LEO
    // vessel would have a link (sampled), drawn as a green halo.
    const relays = w.objects
      .filter((o) => o.func === 'relay')
      .map((o) => {
        const s = objectStateAt(o, t);
        const b = bodyById(o.body);
        const off = b.parent && b.orbit ? bodyOrbitState(b, t).r : null;
        return { pos: off ? { x: s.r.x + off.x, y: s.r.y + off.y } : s.r, name: o.name };
      });
    const refR = EARTH.radius + 300_000;
    g.strokeStyle = 'rgba(90, 220, 140, 0.65)';
    g.lineWidth = 3;
    const segs = 180;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * 2 * Math.PI;
      if (!hasLink({ x: refR * Math.cos(a), y: refR * Math.sin(a) }, t, relays).linked) continue;
      g.beginPath();
      // Canvas angles run clockwise (y down): sweep from −a−δ to −a+δ
      // the SHORT way (ccw=false ⇒ increasing angle).
      g.arc(cx, cy, Rpx * 1.06, -a - Math.PI / segs, -a + Math.PI / segs, false);
      g.stroke();
    }
    g.lineWidth = 1;

    // Sites (discovered only) + the ground station.
    for (const s of SITES) {
      if (s.body !== 'earth' || !siteState(w, s.id).discovered) continue;
      const a = s.angle + spin;
      const [x, y] = px(EARTH.radius * 1.02 * Math.cos(a), EARTH.radius * 1.02 * Math.sin(a));
      g.fillStyle = s.type === 'pad' ? '#ffc756' : '#66ccff';
      g.beginPath();
      g.arc(x, y, 3, 0, 2 * Math.PI);
      g.fill();
      const st = siteState(w, s.id);
      g.fillStyle = '#8fa0c5';
      g.font = '10px system-ui';
      g.fillText(`${s.name}${!st.active ? ' (found)' : st.wearUntil > t ? ' (resetting)' : ''}`, x + 5, y - 3);
    }
    for (const st of GROUND_STATIONS) {
      const p = stationPos(st, t);
      const [x, y] = px(p.x, p.y);
      g.fillStyle = '#ffffff';
      g.fillRect(x - 2, y - 2, 4, 4);
      g.fillStyle = '#8fa0c5';
      g.fillText(st.name, x + 5, y + 8);
    }

    // The Moon, if it fits the view.
    const moon = bodyById('moon');
    const eph = bodyOrbitState(moon, t).r;
    const [mx, my] = px(eph.x, eph.y);
    if (mx > -40 && mx < cw + 40 && my > -40 && my < ch + 40) {
      g.fillStyle = '#9a9aa5';
      g.beginPath();
      g.arc(mx, my, Math.max(2, moon.radius / this.mPerPx), 0, 2 * Math.PI);
      g.fill();
      g.fillStyle = '#8fa0c5';
      g.fillText('Luna', mx + 6, my);
    }

    // Registry: orbit ellipses for satellites, dots for everything.
    for (const o of w.objects) {
      const b = bodyById(o.body);
      const off = b.parent && b.orbit ? bodyOrbitState(b, t).r : { x: 0, y: 0 };
      const el = objectElements(o);
      const color =
        o.kind === 'debris'
          ? '#8a8a90'
          : o.func === 'relay'
            ? '#73bff2'
            : o.func === 'survey'
              ? '#7fe6a0'
              : o.func === 'tug'
                ? '#f2b26a'
                : '#e8e8ee';
      if (o.kind === 'satellite' && el.e < 1) {
        g.strokeStyle = color + '44';
        g.beginPath();
        const p = el.a * (1 - el.e * el.e);
        for (let i = 0; i <= 96; i++) {
          const nu = (i / 96) * 2 * Math.PI;
          const r = p / (1 + el.e * Math.cos(nu));
          const ang = el.argPeri + (el.h >= 0 ? nu : -nu);
          const [x, y] = px(off.x + r * Math.cos(ang), off.y + r * Math.sin(ang));
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
      const s = objectStateAt(o, t);
      const [x, y] = px(off.x + s.r.x, off.y + s.r.y);
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, o.kind === 'debris' ? 1.5 : 2.5, 0, 2 * Math.PI);
      g.fill();
    }
  }
}
