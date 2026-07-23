// Ground roll (plane class): takeoff distance against the classic
// mean-acceleration estimate (Anderson, Aircraft Performance and Design,
// §6.3), liftoff continuity across the regime seam, braking, and the
// runway touchdown → rollout → stop sequence.

import { describe, expect, it } from 'vitest';
import { compile } from '../craft/compile';
import { starterCrafts } from '../craft/craft';
import { Sim } from './sim';
import { siteById } from './sites';
import { add, fromAngle, norm, perp, scale } from './vec2';

function stratoliner(): Sim {
  const starter = starterCrafts().find((s) => s.name === 'Stratoliner')!;
  return new Sim(compile(starter.craft).vehicle);
}

const LEVEL = Math.PI / 2; // pitch command: nose on the horizon
const ROTATE = Math.PI / 2 - (10 * Math.PI) / 180; // nose up 10°

describe('takeoff roll', () => {
  it('accelerates, rotates, and lifts off inside the runway with a continuous seam', () => {
    const sim = stratoliner();
    expect(sim.landed).toBe(true);
    const m0 = sim.state.m;
    // Stall speed for the rotation cue.
    const pa = sim.vehicle.planeAero!;
    const sumSCl = pa.surfaces.reduce((s, sf) => s + sf.S * sf.clMax, 0);
    const vs = Math.sqrt((2 * m0 * 9.798) / (1.225 * sumSCl));
    sim.attitude = { mode: 'pitch', angle: LEVEL };
    sim.throttle = 1;
    let prevSpeed = norm(sim.state.v);
    let liftoffU = 0;
    let seamJump = 0;
    for (let i = 0; i < 4_000 && sim.landed; i++) {
      if (sim.groundSpeed > vs * 1.1) sim.attitude = { mode: 'pitch', angle: ROTATE };
      sim.step(0.05);
      const speed = norm(sim.state.v);
      if (!sim.landed) {
        liftoffU = sim.groundSpeed;
        seamJump = Math.abs(speed - prevSpeed);
      }
      prevSpeed = speed;
    }
    expect(sim.landed).toBe(false);
    expect(sim.events.some((e) => e.type === 'liftoff')).toBe(true);
    // The regime handoff reuses the exact rolling kinematic state — the
    // speed step across the seam is one step's worth of acceleration.
    expect(seamJump).toBeLessThan(1);
    // Anderson §6.3 mean-acceleration estimate: s ≈ V_LO²/(2·ā) with ā
    // evaluated at V_LO/√2. Thrust/drag/lift evaluated with the same
    // models the sim uses — this cross-checks the INTEGRATION.
    const vRef = liftoffU / Math.SQRT2;
    // Static-ish thrust at low Mach: 2 × CFM56 at f(M≈0.24) ≈ interpolate.
    const stage = sim.vehicle.stages[0]!;
    let thrustRef = 0;
    for (const g of stage.engines) {
      const ab = g.engine.airBreathing!;
      const f0 = ab.machTable[0]![1];
      const f1 = ab.machTable[1]![1];
      const mRef = vRef / 340;
      const f = f0 + ((f1 - f0) * mRef) / ab.machTable[1]![0];
      thrustRef += g.engine.thrustSL * f * g.count;
    }
    const q = 0.5 * 1.225 * vRef * vRef;
    // Ground-attitude lift/drag at the pre-rotation attitude (α ≈ wing
    // incidence): Cl per surface ≈ a·incidence.
    let lift = 0;
    let dragS = 0;
    for (const sf of pa.surfaces) {
      const cl = sf.a * Math.abs(sf.incidence);
      lift += q * sf.S * cl * Math.sign(sf.incidence);
      dragS += q * sf.S * (sf.cd0 + (cl * cl) / (Math.PI * sf.e * sf.AR));
    }
    const dragB = q * (sim.vehicle.drag!.cdFaired[0]! * sim.vehicle.drag!.areaFaired[0]! + sim.vehicle.gear!.dragCdA);
    const W = m0 * 9.798;
    const aBar = (thrustRef - dragB - dragS - 0.03 * (W - lift)) / m0;
    const analytic = (liftoffU * liftoffU) / (2 * aBar);
    // Distance actually rolled (rollAngle is private — infer from the
    // liftoff position along the surface):
    const site = siteById('runway-1');
    const surfA = Math.atan2(sim.state.r.y, sim.state.r.x) - sim.body.rotationRate * sim.state.t;
    const rolled = Math.abs(surfA - site.angle) * sim.body.radius;
    expect(rolled).toBeLessThan(4_000);
    expect(Math.abs(rolled - analytic) / analytic).toBeLessThan(0.2);
    // And it flies: three seconds later it is climbing, not crashed.
    for (let i = 0; i < 60; i++) sim.step(0.05);
    expect(sim.crashed).toBe(false);
    expect(sim.vSpeed).toBeLessThan(0); // climbing (vSpeed is down-positive)
  });

  it('cutting the throttle brakes the roll to a stop', () => {
    const sim = stratoliner();
    sim.attitude = { mode: 'pitch', angle: LEVEL };
    sim.throttle = 1;
    for (let i = 0; i < 400 && sim.groundSpeed < 55; i++) sim.step(0.05);
    expect(sim.groundSpeed).toBeGreaterThan(50);
    sim.throttle = 0;
    for (let i = 0; i < 2_000 && sim.groundSpeed > 0.01; i++) sim.step(0.05);
    expect(sim.groundSpeed).toBeLessThan(0.01);
    expect(sim.landed).toBe(true);
    expect(sim.crashed).toBe(false);
  });
});

describe('runway landing', () => {
  /** Put the plane on a shallow final just above the runway threshold. */
  function onFinal(sim: Sim, alt: number, speed: number, sink: number): void {
    const site = siteById('runway-1');
    const a = site.angle + sim.body.rotationRate * sim.state.t;
    const up = fromAngle(a);
    const r = sim.body.radius + alt;
    sim.landed = false;
    sim.state = {
      r: scale(up, r),
      v: add(scale(perp(up), sim.body.rotationRate * r + speed), scale(up, -sink)),
      theta: a + Math.PI / 2 - 0.12, // ~7° nose-up flare (lift ≈ weight at 90 m/s)
      omega: 0,
      m: sim.state.m,
      t: sim.state.t,
    };
    // Positive pitch tips downrange from vertical: nose-UP = angle < 90°.
    sim.attitude = { mode: 'pitch', angle: LEVEL - 0.12 };
    sim.throttle = 0;
  }

  it('touches down inside limits, rolls out under brakes, and stops', () => {
    const sim = stratoliner();
    onFinal(sim, 6, 90, 1.0);
    for (let i = 0; i < 6_000 && !sim.hasLanded && !sim.crashed; i++) sim.step(0.05);
    expect(sim.crashed).toBe(false);
    const touchdown = sim.events.find((e) => e.type === 'landed');
    expect(touchdown).toBeDefined();
    if (touchdown?.type === 'landed') {
      expect(touchdown.vSpeed).toBeLessThan(3);
      expect(touchdown.hSpeed).toBeGreaterThan(50); // a rolling touchdown, not a hover
    }
    expect(sim.hasLanded).toBe(true);
    expect(sim.groundSpeed).toBeLessThan(0.5);
  });

  it('gear-up belly contact is a named landing failure', () => {
    const sim = stratoliner();
    sim.toggleGear(); // retract
    expect(sim.gearDeployed).toBe(false);
    onFinal(sim, 6, 90, 1.0);
    for (let i = 0; i < 2_000 && !sim.crashed; i++) sim.step(0.05);
    expect(sim.crashed).toBe(true);
    const fail = sim.events.find((e) => e.type === 'landingFailed');
    expect(fail).toBeDefined();
    if (fail?.type === 'landingFailed') expect(fail.reason).toContain('horizontal speed');
  });

  it('a too-hard touchdown names the sink-rate limit', () => {
    const sim = stratoliner();
    onFinal(sim, 12, 85, 8); // 8 m/s slam vs the 3 m/s gear design limit
    for (let i = 0; i < 2_000 && !sim.crashed && !sim.landed; i++) sim.step(0.05);
    expect(sim.crashed).toBe(true);
    const fail = sim.events.find((e) => e.type === 'landingFailed');
    if (fail?.type === 'landingFailed') expect(fail.reason).toContain('sink rate');
  });
});
