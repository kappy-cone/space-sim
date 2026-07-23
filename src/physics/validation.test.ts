// Physics validation against closed-form results. These are the guardrails:
// subtly wrong physics still looks like flight, so every core mechanism is
// pinned to an analytic value with tight tolerance.

import { describe, expect, it } from 'vitest';
import { G0, MU_EARTH, R_EARTH } from './constants';
import { FlightState, rk4Step } from './integrator';
import { elementsFromState, propagateKepler } from './kepler';
import { Vec2, norm, scale, sub, unit, vec } from './vec2';

const rel = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

describe('Tsiolkovsky: vacuum, gravity-free burn matches the rocket equation', () => {
  it('Δv = g0·Isp·ln(m0/m1) to 1e-9 relative', () => {
    const isp = 300; // s
    const thrust = 100_000; // N
    const mdot = thrust / (G0 * isp); // constant mass flow
    const m0 = 10_000; // kg
    const propellant = 8_000; // kg
    const burnTime = propellant / mdot;

    // Thrust along +x, no gravity, no drag.
    let s: FlightState = { r: vec(0, 0), v: vec(0, 0), theta: 0, omega: 0, m: m0, t: 0 };
    const dt = burnTime / 2048;
    for (let i = 0; i < 2048; i++) {
      s = rk4Step(s, dt, (st) => ({ dv: vec(thrust / st.m, 0), domega: 0, dm: -mdot }));
    }

    const expected = G0 * isp * Math.log(m0 / (m0 - propellant));
    expect(rel(s.v.x, expected)).toBeLessThan(1e-9);
    expect(s.m).toBeCloseTo(m0 - propellant, 6);
  });
});

describe('Kepler propagation: conservation across a long coast', () => {
  const specificEnergy = (r: Vec2, v: Vec2) => (v.x * v.x + v.y * v.y) / 2 - MU_EARTH / norm(r);

  it('specific energy and angular momentum exact over 1000 orbits (elliptic)', () => {
    // 200 km × 35 786 km transfer-like ellipse.
    const rp = R_EARTH + 200_000;
    const ra = R_EARTH + 35_786_000;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a)); // vis-viva at periapsis
    let r = vec(rp, 0);
    let v = vec(0, vp);
    const e0 = specificEnergy(r, v);
    const h0 = r.x * v.y - r.y * v.x;
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);

    // 1000 orbits in awkward non-commensurate chunks.
    const chunk = period / 7.3;
    let t = 0;
    while (t < 1000 * period) {
      ({ r, v } = propagateKepler(r, v, chunk));
      t += chunk;
    }
    expect(rel(specificEnergy(r, v), e0)).toBeLessThan(1e-9);
    expect(rel(r.x * v.y - r.y * v.x, h0)).toBeLessThan(1e-9);
  });

  it('round trip: forward then backward recovers the state to 1e-8', () => {
    const r0 = vec(R_EARTH + 300_000, 42_000);
    const v0 = vec(-500, 7_800);
    const fwd = propagateKepler(r0, v0, 12_345.678);
    const back = propagateKepler(fwd.r, fwd.v, -12_345.678);
    expect(rel(norm(back.r), norm(r0))).toBeLessThan(1e-8);
    expect(norm(sub(back.r, r0)) / norm(r0)).toBeLessThan(1e-8);
    expect(norm(sub(back.v, v0)) / norm(v0)).toBeLessThan(1e-8);
  });

  it('propagating a full period returns to the start', () => {
    const r0 = vec(R_EARTH + 500_000, 0);
    const v0 = vec(300, Math.sqrt(MU_EARTH / norm(r0)) * 1.1);
    const { period } = elementsFromState(r0, v0);
    const { r, v } = propagateKepler(r0, v0, period);
    expect(norm(sub(r, r0)) / norm(r0)).toBeLessThan(1e-7);
    expect(norm(sub(v, v0)) / norm(v0)).toBeLessThan(1e-7);
  });

  it('elements: circular orbit readouts are exact', () => {
    const r = R_EARTH + 400_000;
    const vCirc = Math.sqrt(MU_EARTH / r);
    const el = elementsFromState(vec(r, 0), vec(0, vCirc));
    expect(rel(el.a, r)).toBeLessThan(1e-12);
    expect(el.e).toBeLessThan(1e-11);
    expect(rel(el.rApo, r)).toBeLessThan(1e-10);
    expect(rel(el.rPeri, r)).toBeLessThan(1e-10);
    expect(rel(el.period, 2 * Math.PI * Math.sqrt((r * r * r) / MU_EARTH))).toBeLessThan(1e-12);
  });

  it('elements: time to apoapsis from periapsis is half the period', () => {
    const rp = R_EARTH + 200_000;
    const a = R_EARTH + 1_000_000;
    const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
    const el = elementsFromState(vec(rp, 0), vec(0, vp));
    expect(rel(el.timeToApo, el.period / 2)).toBeLessThan(1e-9);
  });

  it('RK4 on a pure-gravity arc: energy drift < 1e-10 over one orbit at dt=1s', () => {
    // Validates integrator order; the sim never actually integrates coasts.
    const r0 = R_EARTH + 300_000;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    let s: FlightState = { r: vec(r0, 0), v: vec(0, vCirc), theta: 0, omega: 0, m: 1000, t: 0 };
    const e0 = specificEnergy(s.r, s.v);
    const period = 2 * Math.PI * Math.sqrt((r0 * r0 * r0) / MU_EARTH);
    const steps = Math.ceil(period);
    const gravity = (st: FlightState) => {
      const rn = norm(st.r);
      return { dv: scale(st.r, -MU_EARTH / (rn * rn * rn)), domega: 0, dm: 0 };
    };
    for (let i = 0; i < steps; i++) s = rk4Step(s, 1, gravity);
    expect(rel(specificEnergy(s.r, s.v), e0)).toBeLessThan(1e-10);
  });
});

describe('Hohmann transfer: sim agrees with the closed form', () => {
  it('closed-form impulses produce the target circular orbit', () => {
    const r1 = R_EARTH + 300_000;
    const r2 = R_EARTH + 20_000_000;
    const aT = (r1 + r2) / 2;
    // Closed-form Hohmann Δv (vis-viva at both ends of the transfer ellipse).
    const dv1 = Math.sqrt(MU_EARTH / r1) * (Math.sqrt((2 * r2) / (r1 + r2)) - 1);
    const dv2 = Math.sqrt(MU_EARTH / r2) * (1 - Math.sqrt((2 * r1) / (r1 + r2)));

    // Start on circular orbit at r1, burn dv1 prograde.
    let r = vec(r1, 0);
    let v = vec(0, Math.sqrt(MU_EARTH / r1) + dv1);
    // Coast half the transfer ellipse.
    const tTransfer = Math.PI * Math.sqrt((aT * aT * aT) / MU_EARTH);
    ({ r, v } = propagateKepler(r, v, tTransfer));

    // Arrived at r2, apoapsis, moving retrograde-of-start direction.
    expect(rel(norm(r), r2)).toBeLessThan(1e-9);

    // Burn dv2 prograde (along current velocity): orbit must circularize at r2.
    v = scale(unit(v), norm(v) + dv2);
    const el = elementsFromState(r, v);
    expect(el.e).toBeLessThan(1e-9);
    expect(rel(el.a, r2)).toBeLessThan(1e-9);
  });
});

describe('Drag: terminal velocity matches the analytic value', () => {
  it('v_t = sqrt(2mg/(ρ·Cd·A)) to 1e-8', () => {
    const m = 500; // kg
    const g = 9.81; // uniform test gravity (not Earth model — analytic setup)
    const rho = 1.225;
    const cd = 0.75;
    const area = 2.0; // m²
    const vt = Math.sqrt((2 * m * g) / (rho * cd * area));

    // Drop from rest with constant gravity and constant density.
    let s: FlightState = { r: vec(0, 0), v: vec(0, 0), theta: 0, omega: 0, m, t: 0 };
    const deriv = (st: FlightState) => {
      const speed = norm(st.v);
      const dragAcc =
        speed === 0 ? vec(0, 0) : scale(unit(st.v), (-0.5 * rho * speed * speed * cd * area) / st.m);
      return { dv: vec(dragAcc.x, dragAcc.y - g), domega: 0, dm: 0 };
    };
    // Long enough to converge: v(t) = vt·tanh(g·t/vt); tanh(12) ≈ 1 − 1e-10.
    const tEnd = (12 * vt) / g;
    const dt = 0.02;
    for (let t = 0; t < tEnd; t += dt) s = rk4Step(s, dt, deriv);
    expect(rel(-s.v.y, vt)).toBeLessThan(1e-8);
  });
});
