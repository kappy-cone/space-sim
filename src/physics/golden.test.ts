// Golden trajectory tests: full state series for a reference ascent and a
// reference propulsive landing, pinned against committed fixtures. Any
// change to the physics — integrator, aero, thrust model, autopilot
// guidance — shifts these series and fails here; a DELIBERATE change is
// blessed by regenerating the fixtures:
//
//   GOLDEN_REGEN=1 npx vitest run src/physics/golden.test.ts
//
// then reviewing the fixture diff in the commit. Tolerance is 1e-6
// relative: far above float-op-reordering noise, far below any physical
// change worth noticing.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Autopilot, defaultPlan } from './autopilot';
import { LandingAutopilot } from './landing';
import { Sim } from './sim';
import { vec } from './vec2';
import { compile } from '../craft/compile';
import { referenceCraft, starterCrafts } from '../craft/craft';

interface Sample {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  m: number;
}

const sample = (s: Sim): Sample => ({
  t: s.state.t,
  x: s.state.r.x,
  y: s.state.r.y,
  vx: s.state.v.x,
  vy: s.state.v.y,
  m: s.state.m,
});

/** Autopilot ascent on a fixed 0.25 s control cadence, sampled every 10 s. */
function ascentSeries(craft: ReturnType<typeof referenceCraft>, maxTicks: number): Sample[] {
  const compiled = compile(craft);
  const sim = new Sim(compiled.vehicle);
  const ap = new Autopilot(defaultPlan(250_000, sim.body));
  const out: Sample[] = [sample(sim)];
  for (let tick = 1; tick <= maxTicks && ap.phase !== 'failed'; tick++) {
    ap.update(sim);
    sim.step(0.25);
    if (tick % 40 === 0) out.push(sample(sim));
    if (ap.phase === 'done') break;
  }
  out.push(sample(sim));
  return out;
}

/** Reference ascent: the default craft. */
function runAscent(): Sample[] {
  return ascentSeries(referenceCraft(), 2_400);
}

/** Heavy Lifter ascent: exercises what the reference craft doesn't —
 * solid grain thrust curves, parallel strap-on staging, sepMass/pool
 * bookkeeping, fairing drag states. */
function runHeavyAscent(): Sample[] {
  const starter = starterCrafts().find((s) => s.name === 'Heavy Lifter')!;
  return ascentSeries(starter.craft, 3_600);
}

/** Reference landing: the Test Lander starter dropped from 2.5 km, flown
 * down by the landing autopilot, sampled every 2 s. */
function runLanding(): Sample[] {
  const starter = starterCrafts().find((s) => s.name === 'Test Lander')!;
  const compiled = compile(starter.craft);
  const sim = new Sim(compiled.vehicle);
  const ap = new LandingAutopilot();
  const r = sim.body.radius + 2_500;
  sim.landed = false;
  sim.state = { r: vec(r, 0), v: vec(0, sim.body.rotationRate * r), theta: 0, omega: 0, m: sim.state.m, t: 0 };
  const out: Sample[] = [sample(sim)];
  for (let tick = 1; tick <= 6_000; tick++) {
    ap.update(sim);
    sim.step(0.05);
    if (tick % 40 === 0) out.push(sample(sim));
    if (ap.phase === 'done' || ap.phase === 'failed') break;
  }
  out.push(sample(sim));
  return out;
}

/** Plane takeoff + climb: the Stratoliner at full throttle, scripted
 * rotation at 75 m/s, 60 s of flight — pins the ground-roll regime, the
 * liftoff seam, and the surface-force model in one series. */
function runPlaneTakeoff(): Sample[] {
  const starter = starterCrafts().find((s) => s.name === 'Stratoliner')!;
  const sim = new Sim(compile(starter.craft).vehicle);
  sim.attitude = { mode: 'pitch', angle: Math.PI / 2 };
  sim.throttle = 1;
  const out: Sample[] = [sample(sim)];
  for (let tick = 1; tick <= 1_200; tick++) {
    if (sim.groundSpeed > 75) sim.attitude = { mode: 'pitch', angle: Math.PI / 2 - (10 * Math.PI) / 180 };
    sim.step(0.05);
    if (tick % 40 === 0) out.push(sample(sim));
    if (sim.crashed) break;
  }
  out.push(sample(sim));
  return out;
}

const RUNS: { name: string; run: () => Sample[] }[] = [
  { name: 'ascent', run: runAscent },
  { name: 'heavy-ascent', run: runHeavyAscent },
  { name: 'landing', run: runLanding },
  { name: 'plane-takeoff', run: runPlaneTakeoff },
];

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./golden/${name}.json`, import.meta.url));

/** Compile-aggregate snapshot: every number the builder promises the
 * player, for every shipped craft. Pure functions of the catalog — exact
 * match, no tolerance. This is the "fly a saved rocket before" half of
 * the plane-class regression bar: any change here after the baseline is
 * a physics/compile regression, not noise. */
function compileSnapshot(): Record<string, unknown> {
  const crafts = [
    { name: 'Reference', craft: referenceCraft() },
    ...starterCrafts().map((s) => ({ name: s.name, craft: s.craft })),
  ];
  const out: Record<string, unknown> = {};
  for (const { name, craft } of crafts) {
    const c = compile(craft);
    out[name] = {
      totalDeltaV: c.totalDeltaV,
      reports: c.reports,
      aero: {
        full: { cnAlpha: c.aero.full.cnAlpha, yCoP: c.aero.full.yCoP, staticMarginCal: c.aero.full.staticMarginCal },
        empty: { cnAlpha: c.aero.empty.cnAlpha, yCoP: c.aero.empty.yCoP, staticMarginCal: c.aero.empty.staticMarginCal },
      },
      drag: c.vehicle.drag,
      sepMass: c.vehicle.sepMass,
      strapOn: c.vehicle.strapOn,
      pools: c.vehicle.pools,
      finControlPerQ: c.vehicle.finControlPerQ,
      warnings: c.warnings,
    };
  }
  return out;
}

describe('golden compile aggregates', () => {
  it('every shipped craft compiles to the committed numbers exactly', () => {
    const snap = JSON.parse(JSON.stringify(compileSnapshot())) as Record<string, unknown>;
    const path = fixturePath('compile');
    if (process.env.GOLDEN_REGEN) {
      writeFileSync(path, JSON.stringify(snap, null, 1) + '\n');
      console.warn('[golden] regenerated compile aggregates — review the diff');
      return;
    }
    const golden = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(snap).toEqual(golden);
  });
});

describe('golden trajectories', () => {
  for (const { name, run } of RUNS) {
    it(`${name} matches the committed fixture`, () => {
      const series = run();
      if (process.env.GOLDEN_REGEN) {
        writeFileSync(fixturePath(name), JSON.stringify(series, null, 1) + '\n');
        console.warn(`[golden] regenerated ${name} (${series.length} samples) — review the diff`);
        return;
      }
      const golden = JSON.parse(readFileSync(fixturePath(name), 'utf8')) as Sample[];
      expect(series.length).toBe(golden.length);
      for (let i = 0; i < golden.length; i++) {
        const g = golden[i]!;
        const s = series[i]!;
        for (const k of ['t', 'x', 'y', 'vx', 'vy', 'm'] as const) {
          const tol = Math.max(1e-6 * Math.abs(g[k]), 1e-3);
          if (Math.abs(s[k] - g[k]) > tol) {
            // One rich failure beats 6×N generic ones.
            throw new Error(
              `${name}[${i}].${k} at t=${g.t.toFixed(1)}s: got ${s[k]}, golden ${g[k]} ` +
                `(Δ=${(s[k] - g[k]).toExponential(2)}, tol ${tol.toExponential(2)}). ` +
                `If this change is deliberate, regenerate with GOLDEN_REGEN=1.`,
            );
          }
        }
      }
    });
  }
});
