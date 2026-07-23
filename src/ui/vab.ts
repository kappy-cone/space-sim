// The VAB: 3D editor for building the craft. Left: part palette. Center:
// WebGL2 view with orbit camera. Right: live stats + staging list.
// The craft tree is the single source of truth; every mutation recompiles
// physics and refreshes the panels — TWR and Δv move while you build.

import { PARTS, PartDef, partById } from '../craft/catalog';
import { engineById } from '../physics/parts';
import { propellantById } from '../physics/propellants';
import { massFlow } from '../physics/vehicle';
import { Compiled, LEO_BUDGET, compile } from '../craft/compile';
import {
  Attach,
  Craft,
  CraftPart,
  addPart,
  canAttach,
  deserialize,
  instanceCount,
  newCraft,
  placements,
  referenceCraft,
  removePartSplice,
  serialize,
  starterCrafts,
  subtreeIds,
  partHeight,
} from '../craft/craft';
import { OrbitCamera } from '../gl/camera';
import { multiply, rotationY, scaling, scalingXYZ, translation, v3 } from '../gl/mat4';
import { finMesh, gridMesh, segmentsMesh } from '../gl/mesh';
import { rayFrustums } from '../gl/ray';
import { Renderer } from '../gl/renderer';
import { fmtDeltaV, fmtMass, fmtTime } from './format';

const SYMMETRY_CYCLE = [1, 2, 3, 4, 6, 8];
const CLUSTER_CYCLE = [1, 2, 3, 4, 5, 7, 9];
const STORAGE_KEY = 'space-sim.craft';

interface Ghost {
  parentId: string;
  attach: Attach;
  valid: boolean;
}

export class Vab {
  private craft: Craft;
  private compiled!: Compiled;
  private renderer: Renderer;
  private camera = new OrbitCamera();
  private canvas: HTMLCanvasElement;

  private holding: PartDef | null = null;
  private ghost: Ghost | null = null;
  private symmetry = 1;
  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private mouse = { x: 0, y: 0, inCanvas: false };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private raf = 0;

  private paletteEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private inspectorEl!: HTMLElement;
  private stagingEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private draggingPart: string | null = null;
  private dragStarted = false;
  /** Grab offsets so a drag moves the part relative to where it was
   * grabbed instead of snapping to the cursor ray. */
  private dragOffset = { a: 0, y: 0 };
  /** Mousedown-on-part tracking: becomes a surface drag (radial), a
   * pick-up-and-relocate (stack), or a click-select on release. */
  private pressed: { id: string; x: number; y: number; radial: boolean } | null = null;
  /** A subtree lifted off the craft, following the cursor for re-attach. */
  private pickedUp: { parts: CraftPart[]; rootId: string } | null = null;

  constructor(
    private root: HTMLElement,
    private onLaunch: (compiled: Compiled, craft: Craft) => void,
  ) {
    const saved = localStorage.getItem(STORAGE_KEY);
    this.craft = saved ? deserialize(saved) : referenceCraft();
    try {
      this.undoStack = JSON.parse(localStorage.getItem(`${STORAGE_KEY}.undo`) ?? '[]') as string[];
    } catch {
      this.undoStack = [];
    }

    root.innerHTML = '';
    root.className = 'vab';
    this.buildPalette();

    const center = document.createElement('div');
    center.className = 'vab-center';
    this.canvas = document.createElement('canvas');
    center.appendChild(this.canvas);
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'vab-hint';
    center.appendChild(this.hintEl);
    root.appendChild(center);

    this.buildSidebar();

    this.renderer = new Renderer(this.canvas);
    for (const def of PARTS) {
      const f = def.fin;
      this.renderer.mesh(def.id, () =>
        f ? finMesh(f.cr, f.ct, f.span, f.sweep, f.thickness) : segmentsMesh(def.segments),
      );
    }
    this.renderer.mesh('node', () =>
      segmentsMesh([
        { y0: -0.16, y1: 0, r0: 0, r1: 0.16 },
        { y0: 0, y1: 0.16, r0: 0.16, r1: 0 },
      ]),
    );
    this.renderer.mesh('marker', () =>
      segmentsMesh([
        { y0: -0.3, y1: 0, r0: 0, r1: 0.3 },
        { y0: 0, y1: 0.3, r0: 0.3, r1: 0 },
      ]),
    );
    // Unit ring, scaled per draw to the target face's radius.
    this.renderer.mesh('ring', () => segmentsMesh([{ y0: -0.04, y1: 0.04, r0: 1.06, r1: 1.06 }]));
    this.renderer.lineMesh('grid', gridMesh(30, 2));

    this.camera.attach(center, () => {});
    this.attachInput(center);
    new ResizeObserver(() => this.resize()).observe(center);
    this.resize();
    this.recompile();
    // Start zoomed to fit the loaded craft.
    let maxY = 8;
    for (const pl of placements(this.craft).values()) {
      for (const i of pl.instances) maxY = Math.max(maxY, i.y + pl.def.height);
    }
    this.camera.dist = Math.max(18, maxY * 1.6);
    this.camera.target = v3(0, maxY / 2, 0);
    // Debug hook for driving/inspecting the VAB from the console.
    (window as unknown as { __vab: Vab }).__vab = this;
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
  }

  // ---------- panels ----------

  private buildPalette(): void {
    this.paletteEl = document.createElement('div');
    this.paletteEl.className = 'vab-palette panel';
    const kinds: [string[], string][] = [
      [['payload'], 'Payload'],
      [['tank'], 'Tanks (length adjustable)'],
      [['engine'], 'Engines & Boosters'],
      [['decoupler'], 'Staging & Pylons'],
      [['adapter'], 'Adapters'],
      [['nose', 'fin'], 'Aero & Fairings'],
      [['control'], 'Control'],
      [['leg', 'chute'], 'Landing & Recovery'],
    ];
    for (const [group, title] of kinds) {
      const h = document.createElement('h3');
      h.textContent = title;
      this.paletteEl.appendChild(h);
      for (const def of PARTS.filter((p) => group.includes(p.kind) && !p.hidden)) {
        const b = document.createElement('button');
        b.className = 'part-btn';
        b.textContent = def.name;
        b.title = partStats(def);
        b.onclick = () => {
          this.holding = def;
          this.selectedId = null;
          this.symmetry = 1;
          this.updateHint();
        };
        this.paletteEl.appendChild(b);
      }
    }
    const actions = document.createElement('div');
    actions.className = 'vab-actions';
    const undoBtn = document.createElement('button');
    undoBtn.textContent = '↶ Undo';
    undoBtn.onclick = () => this.undo();
    const redoBtn = document.createElement('button');
    redoBtn.textContent = '↷ Redo';
    redoBtn.onclick = () => this.redo();
    const newBtn = document.createElement('button');
    newBtn.textContent = 'New craft';
    newBtn.onclick = () => {
      console.warn('[vab] New craft clicked — replacing current craft');
      this.pushUndo();
      this.craft = newCraft('capsule');
      this.selectedId = null;
      this.recompile();
    };
    const refBtn = document.createElement('button');
    refBtn.textContent = 'Reference rocket';
    refBtn.onclick = () => {
      this.pushUndo();
      this.craft = referenceCraft();
      this.selectedId = null;
      this.recompile();
    };
    actions.append(undoBtn, redoBtn, newBtn, refBtn);
    this.paletteEl.appendChild(actions);
    this.buildHangar();
    this.root.appendChild(this.paletteEl);
  }

  // ---------- hangar (saved builds + starters) ----------

  private hangarEl!: HTMLElement;

  private savedBuilds(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem('space-sim.hangar') ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }

  private loadCraft(craft: Craft): void {
    this.pushUndo();
    this.craft = JSON.parse(JSON.stringify(craft)) as Craft;
    this.selectedId = null;
    this.recompile();
  }

  private buildHangar(): void {
    this.hangarEl = document.createElement('div');
    this.paletteEl.appendChild(this.hangarEl);
    this.renderHangar();
  }

  private renderHangar(): void {
    this.hangarEl.innerHTML = '<h3>Hangar</h3>';
    // Save the current craft under a name.
    const row = document.createElement('div');
    row.className = 'hangar-save';
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'build name…';
    nameInput.value = this.craft.name === 'Untitled Craft' ? '' : this.craft.name;
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.onclick = () => {
      const name = nameInput.value.trim() || `Build ${Object.keys(this.savedBuilds()).length + 1}`;
      this.craft.name = name;
      const builds = this.savedBuilds();
      builds[name] = serialize(this.craft);
      localStorage.setItem('space-sim.hangar', JSON.stringify(builds));
      this.recompile();
      this.renderHangar();
    };
    row.append(nameInput, saveBtn);
    this.hangarEl.appendChild(row);

    const sub = document.createElement('h3');
    sub.textContent = 'Starters';
    this.hangarEl.appendChild(sub);
    for (const s of starterCrafts()) {
      const b = document.createElement('button');
      b.className = 'part-btn';
      b.textContent = s.name;
      b.onclick = () => this.loadCraft(s.craft);
      this.hangarEl.appendChild(b);
    }

    const builds = this.savedBuilds();
    if (Object.keys(builds).length > 0) {
      const sub2 = document.createElement('h3');
      sub2.textContent = 'Saved';
      this.hangarEl.appendChild(sub2);
      for (const [name, json] of Object.entries(builds)) {
        const rowEl = document.createElement('div');
        rowEl.className = 'hangar-row';
        const load = document.createElement('button');
        load.className = 'part-btn';
        load.textContent = name;
        load.onclick = () => this.loadCraft(deserialize(json));
        const del = document.createElement('button');
        del.className = 'mini';
        del.textContent = '✕';
        del.onclick = () => {
          delete builds[name];
          localStorage.setItem('space-sim.hangar', JSON.stringify(builds));
          this.renderHangar();
        };
        rowEl.append(load, del);
        this.hangarEl.appendChild(rowEl);
      }
    }
  }

  private buildSidebar(): void {
    const side = document.createElement('div');
    side.className = 'vab-side';
    this.statsEl = document.createElement('div');
    this.statsEl.className = 'panel';
    this.inspectorEl = document.createElement('div');
    this.inspectorEl.className = 'panel';
    this.inspectorEl.style.display = 'none';
    this.stagingEl = document.createElement('div');
    this.stagingEl.className = 'panel';
    side.appendChild(this.statsEl);
    side.appendChild(this.inspectorEl);
    side.appendChild(this.stagingEl);
    this.root.appendChild(side);
  }

  /** Selected-part inspector: name + the numbers that matter for it. */
  private renderInspector(): void {
    const id = this.selectedId;
    const p = id ? this.craft.parts[id] : undefined;
    if (!id || !p) {
      this.inspectorEl.style.display = 'none';
      return;
    }
    const def = partById(p.defId);
    const n = instanceCount(this.craft, id);
    const stageIdx = this.compiled.stages.findIndex((cs) => cs.partIds.includes(id));
    const rows: [string, string][] = [];
    rows.push(['Kind', def.kind]);
    if (stageIdx >= 0) rows.push(['Stage', `${stageIdx + 1}`]);
    if (n > 1) rows.push(['Count', `${n}×`]);
    if (def.kind === 'engine' && def.engineId) {
      const e = engineById(def.engineId);
      if (!e.vacuumOnly) rows.push(['Thrust (SL)', `${(e.thrustSL / 1000).toFixed(0)} kN`]);
      rows.push(['Thrust (vac)', `${(e.thrustVac / 1000).toFixed(0)} kN`]);
      if (!e.vacuumOnly) rows.push(['Isp (SL)', `${e.ispSL} s`]);
      rows.push(['Isp (vac)', `${e.ispVac} s`]);
      rows.push(['Mass flow', `${(massFlow(e) * n).toFixed(1)} kg/s${n > 1 ? ' total' : ''}`]);
      rows.push(['Mass', `${fmtMass(e.mass * n)}${n > 1 ? ' total' : ''}`]);
      if (e.vacuumOnly) rows.push(['Note', 'vacuum-only nozzle']);
    } else if (def.kind === 'tank' && def.fluid) {
      const len = partHeight(p, def);
      const vol = Math.PI * def.maxRadius * def.maxRadius * len;
      const fluid = propellantById(def.fluid);
      const prop = vol * 0.95 * fluid.bulkDensity;
      rows.push(['Fluid', `${fluid.name} (${fluid.bulkDensity} kg/m³)`]);
      rows.push(['Propellant', fmtMass(prop * n)]);
      rows.push(['Dry mass', fmtMass(vol * 35 * n)]);
      if (fluid.boiloffPerDay > 0) rows.push(['Boiloff', `${(fluid.boiloffPerDay * 100).toFixed(1)} %/day`]);
      rows.push(['Diameter', `${(def.maxRadius * 2).toFixed(1)} m`]);
      rows.push(['Length', `${len.toFixed(1)} m`]);
    } else if (def.fin) {
      rows.push(['Root/tip chord', `${def.fin.cr} / ${def.fin.ct} m`]);
      rows.push(['Span', `${def.fin.span} m`]);
      rows.push(['Mass', `${fmtMass(def.dryMass * n)}${n > 1 ? ' total' : ''}`]);
      rows.push(['Note', 'moves CoP aft — stability']);
    } else {
      rows.push(['Mass', fmtMass(def.dryMass * n)]);
      if (def.rcsTorque) rows.push(['RCS torque', `${def.rcsTorque} N·m`]);
    }
    if (p.attach.kind === 'radial') {
      rows.push(['Symmetry', `${p.symmetry}× (X to cycle)`]);
      rows.push(['Mount', `y ${p.attach.y.toFixed(1)} m (arrows to move)`]);
    } else if (def.clusterable) {
      rows.push(['Cluster', `${p.symmetry}× (X to cycle)`]);
    }
    this.inspectorEl.style.display = 'block';
    this.inspectorEl.innerHTML =
      `<h3>${def.name}</h3><div class="readouts">` +
      rows.map(([l, v]) => `<div class="label">${l}</div><div class="value">${v}</div>`).join('') +
      '</div>';
    // Parametric tank length: a live slider — length is a build
    // parameter, not a part variant.
    if (def.lengthRange) {
      const wrap = document.createElement('div');
      wrap.style.marginTop = '6px';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = 'Tank length';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(def.lengthRange.min);
      slider.max = String(def.lengthRange.max);
      slider.step = '0.5';
      slider.value = String(partHeight(p, def));
      let undoPushed = false;
      slider.oninput = () => {
        if (!undoPushed) {
          this.pushUndo();
          undoPushed = true;
        }
        p.length = Number(slider.value);
        this.compiled = compile(this.craft);
        this.renderStats();
        this.renderStaging();
      };
      slider.onchange = () => this.recompile();
      wrap.append(label, slider);
      this.inspectorEl.appendChild(wrap);
    }
  }

  private updateHint(): void {
    if (this.holding) {
      const sym = this.holding.kind === 'engine' ? 'cluster' : 'symmetry';
      this.hintEl.textContent = `Placing ${this.holding.name} — click a highlighted node or a surface · X: ${sym} ×${this.symmetry} · Esc: cancel`;
    } else if (this.selectedId) {
      const p = this.craft.parts[this.selectedId];
      const def = p ? partById(p.defId) : null;
      const extra =
        p?.attach.kind === 'radial'
          ? ' · drag or arrows: move · X: symmetry'
          : def?.kind === 'engine'
            ? ' · X: cluster size'
            : '';
      this.hintEl.textContent = `${def?.name ?? ''} — Del: remove${extra}`;
    } else {
      this.hintEl.textContent = 'Drag: orbit · wheel: zoom · shift-drag: pan · click a part to select · ⌘Z undo';
    }
  }

  private renderStats(): void {
    const c = this.compiled;
    const rows = c.stages
      .map((cs, i) => {
        const r = c.reports[i]!;
        const noEngines = cs.stage.engines.length === 0;
        return `<tr>
          <td>S${i + 1}</td>
          <td class="num">${noEngines ? '—' : fmtDeltaV(r.deltaV)}</td>
          <td class="num">${noEngines || r.deltaVSeaLevel <= 0 ? '—' : fmtDeltaV(r.deltaVSeaLevel)}</td>
          <td class="num">${noEngines ? '—' : r.twrIgnition.toFixed(2)}</td>
          <td class="num">${noEngines ? '—' : r.twrBurnout.toFixed(2)}</td>
          <td class="num">${noEngines || !isFinite(r.burnTime) ? '—' : fmtTime(r.burnTime)}</td>
          <td class="num">${fmtMass(r.ignitionMass)}</td>
        </tr>`;
      })
      .join('');
    const m = c.verdict.margin;
    const verdict = c.verdict.ok
      ? `<div class="verdict good">Should make orbit — ${fmtDeltaV(m)} of margin</div>`
      : `<div class="verdict bad">${fmtDeltaV(-m)} short of orbit (needs ~${fmtDeltaV(LEO_BUDGET)})</div>`;
    // Aerodynamic stability: static margin in calibers (CoM/CoP markers on
    // the vehicle: ● blue = CoM, ● red = CoP).
    const marginFull = c.aero.full.staticMarginCal;
    const marginEmpty = c.aero.empty.staticMarginCal;
    const hasAero = c.aero.full.cnAlpha > 0;
    const stabCls = !hasAero || marginFull >= 0.5 ? 'good' : marginFull >= 0 ? 'warn-v' : 'bad';
    const stability = hasAero
      ? `<div class="verdict ${stabCls}">Aero: ${marginFull >= 0 ? 'stable' : 'UNSTABLE'} — margin ${marginFull.toFixed(1)} cal (dry ${marginEmpty.toFixed(1)})
         <span class="legend"><i class="dot com"></i>CoM <i class="dot cop"></i>CoP</span></div>`
      : '';
    const warnings = c.warnings.map((w) => `<div class="warning">⚠ ${w}</div>`).join('');
    this.statsEl.innerHTML = `
      <h3>Vehicle</h3>
      <table class="stage-table">
        <tr><th></th><th>Δv vac</th><th>Δv SL</th><th>TWR ign</th><th>TWR burn</th><th>Burn</th><th>Mass</th></tr>
        ${rows}
      </table>
      <div class="total-dv">Total Δv: <b>${fmtDeltaV(c.totalDeltaV)}</b></div>
      ${verdict}
      ${stability}
      ${warnings}
      <button class="primary launch-btn">Launch ▸</button>`;
    this.statsEl.querySelector<HTMLButtonElement>('.launch-btn')!.onclick = () => {
      localStorage.setItem(STORAGE_KEY, serialize(this.craft));
      this.onLaunch(this.compiled, this.craft);
    };
  }

  private renderStaging(): void {
    const c = this.compiled;
    // Crossfeed drain flows, straight from the compiled burn plan: pool i
    // is crossfed when another stage's burn group lists it ahead of its
    // own pool. Rendered as explicit arrows on both ends of the flow.
    const fedBy = new Map<number, number[]>(); // core stage → strap-on pools it drains first
    const feeds = new Map<number, number[]>(); // strap-on stage → core stages taking its propellant
    for (const ph of c.vehicle.phases ?? []) {
      for (const g of ph.groups) {
        for (const d of g.drain) {
          if (d === g.stage) continue;
          if (!feeds.get(d)?.includes(g.stage)) feeds.set(d, [...(feeds.get(d) ?? []), g.stage]);
          if (!fedBy.get(g.stage)?.includes(d)) fedBy.set(g.stage, [...(fedBy.get(g.stage) ?? []), d]);
        }
      }
    }
    const stageList = (xs: number[]): string => xs.sort((a, b) => a - b).map((x) => `Stage ${x + 1}`).join(', ');
    const rows = c.stages
      .map((cs, i) => {
        const parts = cs.partIds.map((id) => this.craft.parts[id]).filter(Boolean) as CraftPart[];
        const engines = cs.stage.engines.map((g) => `${g.count}× ${g.engine.name}`).join(', ');
        const items = parts
          .map((p) => {
            const def = partById(p.defId);
            const n = instanceCount(this.craft, p.id);
            return `<div class="stage-part" data-part="${p.id}">${n > 1 ? `${n}× ` : ''}${def.name}</div>`;
          })
          .join('');
        const flows: string[] = [];
        if (feeds.has(i)) flows.push(`<div class="drain-flow out">propellant ⟶ ${stageList(feeds.get(i)!)} (drained first)</div>`);
        if (fedBy.has(i)) flows.push(`<div class="drain-flow in">⟵ drains ${stageList(fedBy.get(i)!)} before own tanks</div>`);
        return `<div class="stage-row" data-i="${i}">
          <div class="stage-row-head">
            <b>Stage ${i + 1}${cs.strapOn ? ' ⇉ strap-on, parallel burn' : ''}</b>
            <span>
              <button class="mini" data-move="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
              <button class="mini" data-move="down" data-i="${i}" ${i === c.stages.length - 1 ? 'disabled' : ''}>▼</button>
            </span>
          </div>
          ${flows.join('')}
          <details>
            <summary class="stage-row-body">${engines || 'no engines'} · ${parts.length} parts</summary>
            ${items}
          </details>
        </div>`;
      })
      .join('');
    // Deployables ride the same sequence in flight (space steps through
    // separations first, then these) — shown here so the order is legible
    // before launch. Manual keys fire them anytime. Discovered generically
    // from the parts' DeployDefs: a new tail effect (e.g. landing gear)
    // shows up here with zero new UI code.
    const tailEffects: [string, string][] = [
      ['legs', 'G'],
      ['chutes', 'P'],
    ];
    const deployables: string[] = [];
    for (const [effect, key] of tailEffects) {
      const p = Object.values(this.craft.parts).find((cp) => partById(cp.defId).deploy?.effect === effect);
      if (p) deployables.push(`${partById(p.defId).deploy!.label} (${key})`);
    }
    const tail =
      deployables.length > 0
        ? `<div class="stage-row"><div class="stage-row-head"><b>Then</b></div>${deployables
            .map((d) => `<div class="stage-part">${d}</div>`)
            .join('')}</div>`
        : '';
    this.stagingEl.innerHTML = `<h3>Staging (burns top→bottom)</h3>${rows}${tail}`;
    // Clicking a listed component selects it on the vehicle.
    this.stagingEl.querySelectorAll<HTMLElement>('.stage-part').forEach((el) => {
      el.onclick = () => {
        this.selectedId = el.dataset.part ?? null;
        this.updateHint();
        this.renderInspector();
      };
    });
    this.stagingEl.querySelectorAll<HTMLButtonElement>('button.mini').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        const j = b.dataset.move === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= this.compiled.stages.length) return;
        this.pushUndo();
        const order = this.compiled.stages.map((s) => s.sectionIndex);
        [order[i], order[j]] = [order[j]!, order[i]!];
        this.craft.stageOrder = order;
        this.recompile();
      };
      // Highlight the stage's parts on hover.
      const row = b.closest('.stage-row') as HTMLElement;
      row.onmouseenter = () => (this.hoverStage = Number(row.dataset.i));
      row.onmouseleave = () => (this.hoverStage = null);
    });
  }

  private hoverStage: number | null = null;

  // ---------- mutations ----------

  private pushUndo(): void {
    this.undoStack.push(serialize(this.craft));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    // Persist the recent tail so undo survives a page reload.
    localStorage.setItem(`${STORAGE_KEY}.undo`, JSON.stringify(this.undoStack.slice(-20)));
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(serialize(this.craft));
    this.craft = deserialize(s);
    this.selectedId = null;
    this.recompile();
  }

  /** Roll back to the last pushed undo state as if the aborted gesture
   * never happened: consumes the entry without touching the redo stack.
   * (Cancelling a pickup via undo() used to push the broken mid-pickup
   * craft onto the redo stack and eat legitimate redo history.) */
  private rollback(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.craft = deserialize(s);
    this.selectedId = null;
    this.recompile();
    localStorage.setItem(`${STORAGE_KEY}.undo`, JSON.stringify(this.undoStack.slice(-20)));
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(serialize(this.craft));
    this.craft = deserialize(s);
    this.recompile();
  }

  private recompile(): void {
    this.compiled = compile(this.craft);
    // Safety net: if this save shrinks the craft, stash the previous
    // version (recover with localStorage 'space-sim.craft.bak').
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) {
      try {
        const prevParts = Object.keys((JSON.parse(prev) as Craft).parts).length;
        if (Object.keys(this.craft.parts).length < prevParts) {
          localStorage.setItem(`${STORAGE_KEY}.bak`, prev);
        }
      } catch {
        /* unreadable previous save — ignore */
      }
    }
    localStorage.setItem(STORAGE_KEY, serialize(this.craft));
    this.renderStats();
    this.renderStaging();
    this.renderInspector();
    this.updateHint();
  }

  // ---------- input ----------

  private attachInput(center: HTMLElement): void {
    window.addEventListener('keydown', this.onKey);
    center.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
      this.mouse.inCanvas = true;
      if (this.draggingPart) this.dragMove();
    });
    center.addEventListener('mouseleave', () => (this.mouse.inCanvas = false));

    // Capture-phase: pressing on a part claims the gesture before the
    // camera's orbit handler sees it. A small move then becomes a surface
    // drag (radial parts) or a pick-up-and-relocate (stack parts); a
    // release without movement is a click-select.
    center.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 0 || this.holding || this.pickedUp) return;
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = e.clientX - rect.left;
        this.mouse.y = e.clientY - rect.top;
        const hit = this.pickPart();
        const part = hit ? this.craft.parts[hit.id] : undefined;
        if (part && part.id !== this.craft.rootId) {
          this.pressed = { id: part.id, x: e.clientX, y: e.clientY, radial: part.attach.kind === 'radial' };
          e.stopPropagation();
        }
      },
      true,
    );
    window.addEventListener('mousemove', (e) => {
      const p = this.pressed;
      if (!p || this.draggingPart || this.pickedUp) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      const part = this.craft.parts[p.id];
      if (!part) return;
      this.selectedId = p.id;
      if (p.radial && part.attach.kind === 'radial') {
        this.draggingPart = p.id;
        this.dragStarted = false;
        const grab = this.dragRayHit(p.id);
        this.dragOffset = grab
          ? { a: part.attach.angle - grab.a, y: part.attach.y - grab.y }
          : { a: 0, y: 0 };
      } else {
        this.beginPickup(p.id);
      }
      this.updateHint();
      this.renderInspector();
    });
    window.addEventListener('mouseup', () => {
      if (this.pickedUp) {
        this.finishPickup();
      } else if (!this.draggingPart && this.pressed) {
        // Click without movement: select.
        this.selectedId = this.pressed.id;
        this.updateHint();
        this.renderInspector();
      }
      this.draggingPart = null;
      this.pressed = null;
    });

    let downAt: [number, number] | null = null;
    center.addEventListener('mousedown', (e) => (downAt = [e.clientX, e.clientY]));
    center.addEventListener('mouseup', (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      downAt = null;
      if (moved > 5 || (e.target as HTMLElement).tagName !== 'CANVAS') return; // it was a camera drag
      this.onClick();
    });
  }

  /** Cursor-ray hit on the cylinder a radial part's axis rides on (parent
   * surface + standoff), as parent-local (angle, y). */
  private dragRayHit(partId: string, inflate = 1): { a: number; y: number } | null {
    const part = this.craft.parts[partId];
    if (!part || part.attach.kind !== 'radial' || !part.parentId) return null;
    const parent = this.craft.parts[part.parentId]!;
    const pDef = partById(parent.defId);
    const cDef = partById(part.defId);
    const inst0 = placements(this.craft).get(parent.id)?.instances[0];
    if (!inst0) return null;
    const ray = this.camera.ray(this.mouse.x, this.mouse.y, this.canvas.clientWidth, this.canvas.clientHeight);
    const dist = (cDef.fin ? pDef.maxRadius : pDef.maxRadius + cDef.maxRadius) * inflate;
    const hit = rayFrustums(ray.origin, ray.dir, inst0.x, inst0.z, [
      { y0: inst0.y - 3, y1: inst0.y + pDef.height + 3, r0: dist, r1: dist },
    ]);
    return hit ? { a: hit.angle - inst0.angle, y: hit.y - inst0.y } : null;
  }

  /** Lift a stack part (with its whole subtree) off the craft; it follows
   * the cursor as a ghost until dropped on a valid node. */
  private beginPickup(id: string, undoAlreadyPushed = false): void {
    const root = this.craft.parts[id];
    if (!root) return;
    if (!undoAlreadyPushed) this.pushUndo();
    const ids = [id, ...subtreeIds(this.craft, id)];
    const parts = ids.map((i) => this.craft.parts[i]!);
    for (const i of ids) delete this.craft.parts[i];
    this.pickedUp = { parts, rootId: id };
    this.holding = partById(root.defId); // reuse the ghost/placement flow
    this.selectedId = null;
    this.recompile();
  }

  /** Drop the lifted subtree: re-attach at the ghost node, or cancel. */
  private finishPickup(): void {
    const pu = this.pickedUp;
    this.pickedUp = null;
    this.holding = null;
    if (!pu) return;
    if (this.ghost?.valid) {
      for (const p of pu.parts) this.craft.parts[p.id] = p;
      const root = this.craft.parts[pu.rootId]!;
      root.parentId = this.ghost.parentId;
      root.attach = JSON.parse(JSON.stringify(this.ghost.attach)) as Attach;
      this.selectedId = pu.rootId;
      this.ghost = null;
      this.recompile();
    } else {
      this.ghost = null;
      this.rollback(); // restore the pre-pickup craft; redo history intact
    }
    this.updateHint();
    this.renderInspector();
  }

  /** Drag a radial part along its parent's surface, relative to the grab.
   * Dragging clear off the surface lifts the part into the pickup/ghost
   * flow instead, so radial parts can re-attach to a different parent. */
  private dragMove(): void {
    const part = this.craft.parts[this.draggingPart!];
    if (!part || part.attach.kind !== 'radial' || !part.parentId) return;
    const hit = this.dragRayHit(part.id);
    if (!hit) {
      // Grazing the silhouette edge still counts as "on the surface" —
      // only a miss of the 1.6× inflated cylinder converts to a pickup.
      if (this.dragRayHit(part.id, 1.6)) return; // hold position
      const id = part.id;
      const undoPushed = this.dragStarted;
      this.draggingPart = null;
      if (!this.dragStarted) this.selectedId = id;
      this.beginPickup(id, undoPushed);
      return;
    }
    if (!this.dragStarted) {
      this.pushUndo();
      this.dragStarted = true;
    }
    const pDef = partById(this.craft.parts[part.parentId]!.defId);
    part.attach.y = Math.min(pDef.height - 0.1, Math.max(0.1, hit.y + this.dragOffset.y));
    part.attach.angle = hit.a + this.dragOffset.a;
    this.recompile();
  }

  private onKey = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (e.key === 'Escape') {
      if (this.pickedUp) {
        // Cancel a pick-up: restore the pre-drag craft (pure rollback —
        // not an undo, so redo history survives).
        this.pickedUp = null;
        this.holding = null;
        this.ghost = null;
        this.rollback();
      }
      this.holding = null;
      this.ghost = null;
      this.selectedId = null;
      this.updateHint();
      this.renderInspector();
    } else if (e.key === 'x' || e.key === 'X') {
      this.cycleSymmetry();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.selectedId && this.selectedId !== this.craft.rootId) {
        this.pushUndo();
        // Splice: only the selected part goes; the stack below re-attaches
        // upward. Radial subtrees (boosters + their parts) go together.
        const removed = removePartSplice(this.craft, this.selectedId);
        console.warn('[vab] delete:', removed.join(', '));
        this.selectedId = null;
        this.recompile();
      }
    } else if (this.selectedId) {
      const p = this.craft.parts[this.selectedId];
      if (p && p.attach.kind === 'radial') {
        const step = e.shiftKey ? 0.05 : 0.25;
        let changed = true;
        if (e.key === 'ArrowLeft') p.attach.angle -= Math.PI / 24;
        else if (e.key === 'ArrowRight') p.attach.angle += Math.PI / 24;
        else if (e.key === 'ArrowUp') p.attach.y += step;
        else if (e.key === 'ArrowDown') p.attach.y -= step;
        else changed = false;
        if (changed) {
          e.preventDefault();
          const parent = this.craft.parts[p.parentId!]!;
          const pDef = partById(parent.defId);
          p.attach.y = Math.min(pDef.height, Math.max(0, p.attach.y));
          this.recompile();
        }
      }
    }
  };

  private cycleSymmetry(): void {
    const cycleFor = (def: PartDef): number[] =>
      def.kind === 'engine' ? CLUSTER_CYCLE : SYMMETRY_CYCLE;
    if (this.holding) {
      const cyc = cycleFor(this.holding);
      this.symmetry = cyc[(cyc.indexOf(this.symmetry) + 1) % cyc.length]!;
      this.updateHint();
    } else if (this.selectedId) {
      const p = this.craft.parts[this.selectedId];
      if (!p) return;
      const def = partById(p.defId);
      if (p.attach.kind !== 'radial' && !(def.kind === 'engine' && def.clusterable)) return;
      const cyc = cycleFor(def);
      this.pushUndo();
      p.symmetry = cyc[(cyc.indexOf(p.symmetry) + 1) % cyc.length]!;
      this.recompile();
    }
  }

  private onClick(): void {
    if (this.holding && this.ghost?.valid) {
      this.pushUndo();
      const def = this.holding;
      const sym = def.kind === 'engine' || this.ghost.attach.kind === 'radial' ? this.symmetry : 1;
      addPart(this.craft, this.ghost.parentId, def.id, this.ghost.attach, sym);
      this.holding = null;
      this.ghost = null;
      this.recompile();
      return;
    }
    // Select what's under the cursor.
    this.selectedId = this.pickPart()?.id ?? null;
    this.updateHint();
    this.renderInspector();
  }

  // ---------- picking & ghost ----------

  private pickPart(): { id: string; y: number; angle: number } | null {
    const place = placements(this.craft);
    const ray = this.camera.ray(this.mouse.x, this.mouse.y, this.canvas.clientWidth, this.canvas.clientHeight);
    let best: { id: string; y: number; angle: number; t: number } | null = null;
    for (const [id, pl] of place) {
      for (const inst of pl.instances) {
        const segs = pl.def.segments.map((sg) => ({
          y0: inst.y + sg.y0,
          y1: inst.y + sg.y1,
          r0: sg.r0,
          r1: sg.r1,
        }));
        const hit = rayFrustums(ray.origin, ray.dir, inst.x, inst.z, segs);
        if (hit && (!best || hit.t < best.t)) {
          best = { id, y: hit.y - inst.y, angle: hit.angle, t: hit.t };
        }
      }
    }
    return best;
  }

  /** Update the ghost for the held part from the current mouse position. */
  private updateGhost(): void {
    this.ghost = null;
    if (!this.holding || !this.mouse.inCanvas) return;
    const place = placements(this.craft);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    // 1) Stack nodes within 36 px of the cursor win.
    let bestNode: { parentId: string; attach: Attach; d: number } | null = null;
    for (const [id, pl] of place) {
      const inst = pl.instances[0]!;
      const nodes: { attach: Attach; y: number }[] = [];
      if (canAttach(this.craft, id, this.holding.id, { kind: 'below' })) {
        nodes.push({ attach: { kind: 'below' }, y: inst.y });
      }
      if (canAttach(this.craft, id, this.holding.id, { kind: 'above' })) {
        nodes.push({ attach: { kind: 'above' }, y: inst.y + pl.def.height });
      }
      for (const n of nodes) {
        const px = this.project(inst.x, n.y, inst.z, w, h);
        if (!px) continue;
        const d = Math.hypot(px[0] - this.mouse.x, px[1] - this.mouse.y);
        if (d < 36 && (!bestNode || d < bestNode.d)) {
          bestNode = { parentId: id, attach: n.attach, d };
        }
      }
    }
    if (bestNode) {
      this.ghost = { parentId: bestNode.parentId, attach: bestNode.attach, valid: true };
      return;
    }

    // 2) Radial attach on the surface under the cursor.
    const hit = this.pickPart();
    if (hit && canAttach(this.craft, hit.id, this.holding.id, { kind: 'radial', angle: 0, y: 0 })) {
      const parent = this.craft.parts[hit.id]!;
      const pDef = partById(parent.defId);
      const y = Math.min(pDef.height - 0.2, Math.max(0.2, hit.y));
      this.ghost = { parentId: hit.id, attach: { kind: 'radial', angle: hit.angle, y }, valid: true };
    }
  }

  private project(x: number, y: number, z: number, w: number, h: number): [number, number] | null {
    const view = this.camera.view();
    const proj = this.camera.proj(w / h);
    const m = multiply(proj, view);
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (cw <= 0) return null;
    return [((cx / cw) * 0.5 + 0.5) * w, (0.5 - (cy / cw) * 0.5) * h];
  }

  // ---------- render ----------

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const parent = this.canvas.parentElement!;
    this.canvas.width = parent.clientWidth * dpr;
    this.canvas.height = parent.clientHeight * dpr;
    this.canvas.style.width = `${parent.clientWidth}px`;
    this.canvas.style.height = `${parent.clientHeight}px`;
  }

  private frame = (): void => {
    this.updateGhost();
    if (!this.holding) this.hoverId = this.mouse.inCanvas ? (this.pickPart()?.id ?? null) : null;

    const place = placements(this.craft);
    // Keep the camera target near the craft's vertical middle.
    let maxY = 0;
    for (const pl of place.values()) {
      for (const i of pl.instances) maxY = Math.max(maxY, i.y + pl.def.height);
    }
    this.camera.target = v3(0, Math.min(this.camera.target.y * 0.9 + (maxY / 2) * 0.1, maxY), 0);

    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.begin(this.camera.proj(w / h), this.camera.viewRot(), this.camera.eye(), [0.045, 0.055, 0.085]);
    this.renderer.draw('grid', translation(0, 0, 0), [0.16, 0.2, 0.3], 1, true);

    const hoverStageIds =
      this.hoverStage !== null ? new Set(this.compiled.stages[this.hoverStage]?.partIds) : null;

    for (const [id, pl] of place) {
      // Parametric tanks: scale the mesh Y to the build-time length.
      const hScale = pl.height / pl.def.height;
      for (const inst of pl.instances) {
        let model = multiply(translation(inst.x, inst.y, inst.z), rotationY(-inst.angle));
        if (hScale !== 1) model = multiply(model, scalingXYZ(1, hScale, 1));
        let color = pl.def.color;
        if (id === this.selectedId) color = [1.0, 0.8, 0.35];
        else if (id === this.hoverId && !this.holding) color = [color[0] * 1.25, color[1] * 1.25, color[2] * 1.25];
        else if (hoverStageIds?.has(id)) color = [0.5, 0.9, 0.6];
        this.renderer.draw(pl.def.id, model, color);
      }
    }

    // Ghost preview (clone the craft, place, draw translucent).
    if (this.holding && this.ghost) {
      const clone = deserialize(serialize(this.craft));
      const sym = this.holding.kind === 'engine' || this.ghost.attach.kind === 'radial' ? this.symmetry : 1;
      const added = addPart(clone, this.ghost.parentId, this.holding.id, this.ghost.attach, sym);
      const clonePlace = placements(clone);
      const gp = clonePlace.get(added.id);
      // The clone re-floors to y=0; rebase so the ghost lines up with the
      // craft as currently drawn.
      const dy =
        (clonePlace.get(clone.rootId)?.instances[0]?.y ?? 0) -
        (place.get(this.craft.rootId)?.instances[0]?.y ?? 0);
      if (gp) {
        for (const inst of gp.instances) {
          const model = multiply(translation(inst.x, inst.y - dy, inst.z), rotationY(-inst.angle));
          this.renderer.draw(this.holding.id, model, [0.45, 1.0, 0.6], 0.62);
        }
      }
      // Pulsing highlight ring on the target attachment face — makes the
      // connection point unmistakable (engine mounts hide under tanks).
      const gpar = place.get(this.ghost.parentId);
      if (gpar) {
        const gi = gpar.instances[0]!;
        const at = this.ghost.attach;
        const ringY =
          at.kind === 'below' ? gi.y : at.kind === 'above' ? gi.y + gpar.def.height : gi.y + at.y;
        const ringR =
          at.kind === 'radial'
            ? gpar.def.maxRadius
            : at.kind === 'below'
              ? gpar.def.radiusBottom
              : gpar.def.radiusTop;
        const pulse = 0.55 + 0.3 * Math.sin(performance.now() / 130);
        this.renderer.draw(
          'ring',
          multiply(translation(gi.x, ringY, gi.z), scaling(Math.max(ringR, 0.3))),
          [0.45, 1.0, 0.6],
          pulse,
          true,
          true,
        );
      }
    }

    // CoM (blue) / CoP (red) markers on the vehicle axis, always on top.
    const aero = this.compiled.aero.full;
    this.renderer.draw('marker', translation(0, aero.yCoM, 0), [0.35, 0.65, 1.0], 0.95, true, true);
    if (aero.cnAlpha > 0) {
      this.renderer.draw('marker', translation(0, aero.yCoP, 0), [1.0, 0.35, 0.35], 0.95, true, true);
    }

    // Open stack nodes while holding — sized with camera distance so they
    // stay visible from any zoom.
    if (this.holding) {
      const nodeScale = Math.min(3, Math.max(0.7, this.camera.dist * 0.02));
      const drawNode = (x: number, y: number, z: number): void => {
        this.renderer.draw(
          'node',
          multiply(translation(x, y, z), scaling(nodeScale)),
          [0.4, 1, 0.55],
          0.95,
          true,
          true,
        );
      };
      for (const [id, pl] of place) {
        const inst = pl.instances[0]!;
        if (canAttach(this.craft, id, this.holding.id, { kind: 'below' })) drawNode(inst.x, inst.y, inst.z);
        if (canAttach(this.craft, id, this.holding.id, { kind: 'above' })) {
          drawNode(inst.x, inst.y + pl.def.height, inst.z);
        }
      }
    }

    this.raf = requestAnimationFrame(this.frame);
  };
}


/** Parts-bin tooltip: the numbers that make each tradeoff visible —
 * why you'd pick one part over another, without opening the source. */
function partStats(def: PartDef): string {
  const lines: string[] = [];
  const eid = def.engineId ?? def.solidMotor;
  if (eid) {
    const e = engineById(eid);
    if (e.propellant !== 'solid') {
      lines.push(`${e.propellant} · ρ ${propellantById(e.propellant).bulkDensity} kg/m³`);
    } else {
      lines.push('solid — no throttle, no shutdown, no restart');
    }
    lines.push(
      `thrust ${e.thrustSL > 0 ? (e.thrustSL / 1000).toFixed(0) + ' kN SL / ' : ''}${(e.thrustVac / 1000).toFixed(0)} kN vac`,
    );
    lines.push(`Isp ${e.ispSL > 0 ? e.ispSL + ' s SL / ' : ''}${e.ispVac} s vac`);
    lines.push(`ε ${e.expansionRatio}:1 · gimbal ±${e.gimbalDeg}° · ${fmtMass(def.dryMass)}`);
    lines.push(
      `throttle ${e.throttleable ? Math.round(e.minThrottle * 100) + '–100%' : 'fixed'} · ignitions ${isFinite(e.ignitions) ? e.ignitions : '∞'}${e.ullageImmune ? ' · lights unsettled' : ''}`,
    );
    if (isFinite(e.maxAmbientPressure)) {
      lines.push(`⚠ separates above ${(e.maxAmbientPressure / 1000).toFixed(1)} kPa ambient`);
    }
    if (e.nozzleExtension) lines.push(`extendable nozzle ${e.nozzleExtension.stowedExpansionRatio}:1 → ${e.expansionRatio}:1`);
    if (def.propellant) lines.push(`grain ${fmtMass(def.propellant)}`);
  } else if (def.fluid) {
    const f = propellantById(def.fluid);
    lines.push(`${f.name} · ρ ${f.bulkDensity} kg/m³`);
    lines.push(`boiloff ${f.boiloffPerDay > 0 ? (f.boiloffPerDay * 100).toFixed(1) + ' %/day' : 'none (storable)'}`);
    lines.push('length adjustable after placing · structure 35 kg/m³ of volume');
  } else {
    lines.push(fmtMass(def.dryMass));
    if (def.control?.rcsThrust) lines.push(`RCS ${def.control.rcsThrust} N, ${def.control.rcsPropellant} kg budget — settles tanks anywhere`);
    if (def.control?.wheelTorque) lines.push(`CMG ${def.control.wheelTorque} N·m, free but saturates at ${def.control.wheelCapacity} N·m·s`);
    if (def.control?.finControl) lines.push('active control surface — authority scales with q');
    if (def.ullage) lines.push('fire to settle propellant for a pump-fed relight');
    if (def.crossfeed) lines.push('crossfeed: core engines drain the strap-on first (asparagus)');
    else if (def.kind === 'decoupler' && def.radialChild) lines.push('strap-on mount: hangs a parallel-burning booster stack');
    if (def.fairing) lines.push('encloses the payload from the airstream; jettison via staging');
    if (def.noseCd !== undefined) lines.push(`nose drag class Cd ${def.noseCd}`);
  }
  lines.push('— ' + def.source);
  return lines.join('\n');
}
