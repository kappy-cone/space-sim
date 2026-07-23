// Fixed-step classical RK4 integrator over the 3-DOF planar flight state:
// [x, y, θ, vx, vy, ω] plus mass. Used only for powered and in-atmosphere
// flight; coast arcs go through the analytic Kepler propagator instead.

import { Vec2, add, scale } from './vec2';

export interface FlightState {
  r: Vec2; // position, body-centered inertial [m]
  v: Vec2; // inertial velocity [m/s]
  theta: number; // body attitude: world angle of the nose axis [rad]
  omega: number; // angular velocity [rad/s]
  m: number; // total mass [kg]
  t: number; // time since launch [s]
}

/** Time derivative: dr/dt = v, dv/dt = a, dθ/dt = ω, dω/dt = τ/I, dm/dt = −ṁ. */
export interface Derivative {
  dv: Vec2; // acceleration [m/s²]
  domega: number; // angular acceleration [rad/s²]
  dm: number; // mass rate [kg/s] (negative while burning)
}

export type DerivFn = (s: FlightState) => Derivative;

/** One classical RK4 step of size dt. */
export function rk4Step(s: FlightState, dt: number, f: DerivFn): FlightState {
  const k1 = f(s);
  const s2 = midState(s, s, k1, dt / 2);
  const k2 = f(s2);
  const s3 = midState(s, s2, k2, dt / 2);
  const k3 = f(s3);
  const s4 = midState(s, s3, k3, dt);
  const k4 = f(s4);

  // dr/dt = v and dθ/dt = ω, so the position/attitude slopes are the
  // stage-state velocities: s.v, s2.v, s3.v, s4.v (and ω likewise).
  return {
    r: add(s.r, scale(add(add(s.v, scale(add(s2.v, s3.v), 2)), s4.v), dt / 6)),
    v: add(s.v, scale(add(add(k1.dv, scale(add(k2.dv, k3.dv), 2)), k4.dv), dt / 6)),
    theta: s.theta + ((s.omega + 2 * s2.omega + 2 * s3.omega + s4.omega) * dt) / 6,
    omega: s.omega + ((k1.domega + 2 * k2.domega + 2 * k3.domega + k4.domega) * dt) / 6,
    m: s.m + ((k1.dm + 2 * k2.dm + 2 * k3.dm + k4.dm) * dt) / 6,
    t: s.t + dt,
  };
}

/** Euler sub-state from base state s0 stepping with slope-of-state sv and derivative k. */
function midState(s0: FlightState, sv: FlightState, k: Derivative, h: number): FlightState {
  return {
    r: add(s0.r, scale(sv.v, h)),
    v: add(s0.v, scale(k.dv, h)),
    theta: s0.theta + sv.omega * h,
    omega: s0.omega + k.domega * h,
    m: s0.m + k.dm * h,
    t: s0.t + h,
  };
}
