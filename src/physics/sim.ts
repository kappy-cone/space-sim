// Flight simulation, 3-DOF planar: state [x, y, θ, vx, vy, ω] + mass.
// Three regimes:
//   integrated — powered/atmospheric flight, fixed-step RK4 with attitude
//                dynamics (gimbal + aero torques + chutes);
//   on-rails   — vacuum coast via analytic Kepler (never integrated);
//   surface    — held on the rotating surface (pad hold-down before
//                liftoff, frozen after a successful landing) — a resting
//                vehicle is pinned, not integrated, so it cannot jitter
//                or sink.
// All orbital state is relative to a named reference body.
//
// Attitude model:
// - Thrust along the body axis rotated by the gimbal angle δ, applied at
//   the engine plane → torque −T·ℓ·sin δ about the CoM; PD-controlled,
//   |δ| ≤ 5° (typical of flown engines).
// - Aerodynamic normal force N = q·A_ref·C_Nα·α at the Barrowman CoP
//   (restoring iff CoP is aft of CoM) + pitch damping.
// - Axial drag ½ρv²·Cd(M)·A with the transonic drag-rise curve — Cd is
//   not constant through max-Q (atmosphere.machDragFactor).
// - Deployed parachutes pull q·CdA opposite the airspeed at their mount
//   height — a canopy above the CoM is a restoring pendulum.
// - Small pod RCS torque when engines are off; on-rails coasts slew
//   attitude instead of integrating it.
//
// Δv accounting (always on): d|v|/dt = T·v̂/m + F_aero·v̂/m − g sinγ
// integrates to  Δ|v| = idealDv − steeringLoss − aeroLoss − gravityLoss,
// an exact identity (trapezoid-accumulated) — see the validation suite.

import { CelestialBody, EARTH } from './bodies';
import { FlightState, rk4Step } from './integrator';
import { Elements, elementsFromState, propagateKepler } from './kepler';
import { MassProperties, massProperties, synthesizeGeometry } from './massmodel';
import { machDragFactor, speedOfSound } from './atmosphere';
import { Vec2, add, cross, dot, norm, perp, scale, sub, vec, fromAngle } from './vec2';
import {
  Vehicle,
  massFromStage,
  stageDryMass,
  stageMassFlow,
  stagePropellant,
  stageThrustAtPressure,
} from './vehicle';

export type Attitude =
  | { mode: 'vertical' }
  | { mode: 'pitch'; angle: number } // pitch from local vertical, + downrange
  | { mode: 'surfacePrograde' }
  | { mode: 'surfaceRetrograde' } // for landing burns
  | { mode: 'prograde' };

export type SimEvent =
  | { type: 'liftoff'; t: number }
  | { type: 'stageBurnout'; t: number; stage: number }
  | { type: 'stageSeparation'; t: number; stage: number }
  | { type: 'orbit'; t: number }
  | { type: 'partTorn'; t: number; partName: string }
  | { type: 'breakup'; t: number; q: number }
  | { type: 'chuteDeployed'; t: number }
  | { type: 'legsDeployed'; t: number }
  | { type: 'landed'; t: number; vSpeed: number; hSpeed: number; tilt: number }
  | { type: 'landingFailed'; t: number; reason: string }
  | { type: 'crash'; t: number; speed: number };

/** Touchdown limits [m/s, rad] — engineering estimates per landing mode. */
export const TOUCHDOWN_LIMITS = {
  legs: { vSpeed: 6, hSpeed: 2, tilt: (15 * Math.PI) / 180 }, // F9-class gear
  chute: { vSpeed: 8, hSpeed: 4, tilt: (30 * Math.PI) / 180 }, // capsule under canopy
  none: { vSpeed: 3, hSpeed: 1, tilt: (8 * Math.PI) / 180 }, // engine-bell touchdown
};

const MAX_POWERED_DT = 0.05;
const GIMBAL_MAX = (5 * Math.PI) / 180;
const SPOOL_TAU = 0.4; // s — first-order thrust response (approximation)
const COAST_SLEW_RATE = (5 * Math.PI) / 180; // rad/s on rails
const KP = 0.5; // PD attitude gains: ωn ≈ 0.7 rad/s, ζ ≈ 1
const KD = 1.4;

export class Sim {
  readonly vehicle: Vehicle;
  readonly body: CelestialBody;
  state: FlightState;
  stageIndex = 0;
  propellant: number;
  throttle = 1;
  actualThrottle = 0;
  attitude: Attitude = { mode: 'vertical' };
  gimbal = 0;
  /** Surface regime flag (pad hold-down or landed). */
  landed = true;
  /** Surface-fixed angle of the resting point (sim-plane, at t = 0). */
  private restAngle0 = 0;
  crashed = false;
  inOrbit = false;
  hasLanded = false; // made a successful landing after flight
  events: SimEvent[] = [];
  torn = new Set<string>();
  legsDeployed = false;
  chutesDeployed = false;
  q = 0;
  aoa = 0;
  mach = 0;
  // Δv loss accounting [m/s].
  idealDv = 0;
  gravityLoss = 0;
  aeroLoss = 0;
  steeringLoss = 0;

  private geom;

  constructor(vehicle: Vehicle, body: CelestialBody = EARTH) {
    this.vehicle = vehicle;
    this.body = body;
    this.geom = vehicle.geometry ?? synthesizeGeometry(vehicle.stages, vehicle.payloadMass);
    this.state = { r: vec(0, 0), v: vec(0, 0), theta: 0, omega: 0, m: massFromStage(vehicle, 0), t: 0 };
    this.propellant = stagePropellant(vehicle.stages[0]!);
    this.pinToSurface(); // launch pad: equator, +x, nose up
  }

  // ---------- geometry-derived readouts ----------

  get altitude(): number {
    return norm(this.state.r) - this.body.radius;
  }

  /** Height of the CoM above the vehicle's lowest structural point. */
  comAboveGround(): number {
    return this.massProps.yCoM - this.attachedBottomY();
  }

  /** Radar altitude: the lowest hull corner above the surface — attitude-
   * aware, distinct from `altitude` (CoM above mean radius). */
  get radarAltitude(): number {
    const props = this.massProps;
    const u = this.bodyAxis;
    const side = perp(u);
    const yLow = this.attachedBottomY() - props.yCoM; // negative
    const yHigh = this.attachedTopY() - props.yCoM;
    const w = this.halfWidth();
    let min = Infinity;
    for (const [along, across] of [
      [yLow, -w],
      [yLow, w],
      [yHigh, -w],
      [yHigh, w],
    ] as const) {
      const p = add(this.state.r, add(scale(u, along), scale(side, across)));
      min = Math.min(min, norm(p) - this.body.radius);
    }
    return min;
  }

  /** Vertical (down-positive) and horizontal surface-relative speeds. */
  get vSpeed(): number {
    const up = scale(this.state.r, 1 / norm(this.state.r));
    return -dot(this.airspeedVec, up);
  }

  get hSpeed(): number {
    const up = scale(this.state.r, 1 / norm(this.state.r));
    return Math.abs(cross(up, this.airspeedVec));
  }

  /** Tilt of the body axis from local vertical [rad]. */
  get tilt(): number {
    const up = Math.atan2(this.state.r.y, this.state.r.x);
    return Math.abs(wrapPi(this.state.theta - up));
  }

  get airspeedVec(): Vec2 {
    return sub(this.state.v, scale(perp(this.state.r), this.body.rotationRate));
  }

  get elements(): Elements {
    return elementsFromState(this.state.r, this.state.v, this.body.mu);
  }

  get burning(): boolean {
    return (
      !this.crashed &&
      this.throttle > 0 &&
      this.propellant > 0 &&
      this.stageIndex < this.vehicle.stages.length
    );
  }

  get massProps(): MassProperties {
    const stage = this.vehicle.stages[this.stageIndex];
    const full = stage ? stagePropellant(stage) : 0;
    return massProperties(this.geom, this.stageIndex, full > 0 ? this.propellant / full : 0, this.torn);
  }

  get bodyAxis(): Vec2 {
    return fromAngle(this.state.theta);
  }

  thrustDirection(): Vec2 {
    return fromAngle(this.state.theta + this.gimbal);
  }

  /** Attached deployed chutes (not torn, still on the vehicle). */
  activeChutes(): { cdA: number; y: number }[] {
    if (!this.chutesDeployed) return [];
    return this.geom.chutes
      .filter((c) => c.stage >= this.stageIndex && !this.torn.has(c.partId))
      .map((c) => ({ cdA: c.cdA, y: c.y }));
  }

  /** Deployed-leg footprint radius (0 when none/stowed). */
  legFootprint(): number {
    if (!this.legsDeployed) return 0;
    let f = 0;
    for (const l of this.geom.legs) {
      if (l.stage >= this.stageIndex && !this.torn.has(l.partId)) f = Math.max(f, l.footprint);
    }
    return f;
  }

  /**
   * Suicide-burn altitude: the radar altitude at which a full-throttle
   * retrograde burn just nulls the vertical speed at the surface —
   * h = v²/(2(a_max − g)) with current mass and local thrust, plus one
   * spool time-constant of free fall as margin. NaN when not descending
   * or when max thrust cannot beat gravity.
   */
  get suicideBurnAltitude(): number {
    const stage = this.vehicle.stages[this.stageIndex];
    if (!stage || this.vSpeed <= 0) return NaN;
    const p = this.body.atmosphere?.pressure(Math.max(0, this.altitude)) ?? 0;
    const rn = norm(this.state.r);
    const g = this.body.mu / (rn * rn);
    const aMax = stageThrustAtPressure(stage, p) / this.state.m - g;
    if (aMax <= 0) return NaN;
    const v = this.vSpeed;
    return (v * v) / (2 * aMax) + v * SPOOL_TAU;
  }

  /** Commanded attitude as a world angle. */
  targetAngle(): number {
    const upA = Math.atan2(this.state.r.y, this.state.r.x);
    switch (this.attitude.mode) {
      case 'vertical':
        return upA;
      case 'pitch':
        // Positive pitch tips downrange (direction of orbital motion).
        return upA + this.attitude.angle * Math.sign(cross(this.state.r, this.state.v) || 1);
      case 'surfacePrograde': {
        const air = this.airspeedVec;
        return norm(air) < 1 ? upA : Math.atan2(air.y, air.x);
      }
      case 'surfaceRetrograde': {
        const air = this.airspeedVec;
        return norm(air) < 1 ? upA : Math.atan2(-air.y, -air.x);
      }
      case 'prograde':
        return Math.atan2(this.state.v.y, this.state.v.x);
    }
  }

  // ---------- commands ----------

  deployLegs(): void {
    if (this.legsDeployed || this.geom.legs.length === 0) return;
    this.legsDeployed = true;
    this.events.push({ type: 'legsDeployed', t: this.state.t });
  }

  deployChutes(): void {
    if (this.chutesDeployed) return;
    const chutes = this.geom.chutes.filter((c) => c.stage >= this.stageIndex && !this.torn.has(c.partId));
    if (chutes.length === 0) return;
    this.chutesDeployed = true;
    // Safe-deploy envelope: above it the canopy tears immediately.
    for (const c of chutes) {
      if (this.q > c.safeQ) {
        this.torn.add(c.partId);
        this.events.push({ type: 'partTorn', t: this.state.t, partName: 'Parachute (over safe q)' });
      }
    }
    if (this.activeChutes().length > 0) this.events.push({ type: 'chuteDeployed', t: this.state.t });
  }

  stage(): void {
    if (this.stageIndex >= this.vehicle.stages.length) return;
    const dropped = this.vehicle.stages[this.stageIndex]!;
    this.state.m -= stageDryMass(dropped) + this.propellant;
    this.events.push({ type: 'stageSeparation', t: this.state.t, stage: this.stageIndex });
    this.stageIndex += 1;
    const next = this.vehicle.stages[this.stageIndex];
    this.propellant = next ? stagePropellant(next) : 0;
    this.actualThrottle = 0; // fresh engines must spool up
  }

  // ---------- stepping ----------

  step(dt: number): void {
    if (this.crashed) return;
    const atmTop = this.body.atmosphere?.topAltitude ?? 0;
    let remaining = dt;
    while (remaining > 1e-9) {
      if (this.landed) {
        remaining -= this.stepSurface(Math.min(remaining, MAX_POWERED_DT));
      } else if (this.burning || this.actualThrottle > 0.01 || this.altitude < atmTop) {
        remaining -= this.stepPowered(Math.min(remaining, MAX_POWERED_DT));
      } else {
        // On-rails coast: exact Kepler; attitude assumed RCS-held.
        const vPre = norm(this.state.v);
        const { r, v } = propagateKepler(this.state.r, this.state.v, remaining, this.body.mu);
        // Gravity is the only force on rails, so its Δv-budget term is
        // exactly the speed change (∫g·sinγ dt = |v₀| − |v₁|).
        this.gravityLoss += vPre - norm(v);
        const err = wrapPi(this.targetAngle() - this.state.theta);
        const slew = Math.min(Math.abs(err), COAST_SLEW_RATE * remaining) * Math.sign(err);
        this.state = { r, v, theta: this.state.theta + slew, omega: 0, m: this.state.m, t: this.state.t + remaining };
        this.q = 0;
        this.aoa = 0;
        this.mach = 0;
        remaining = 0;
        this.checkOrbit();
      }
    }
  }

  /** Pin the vehicle to the rotating surface at restAngle0. */
  private pinToSurface(): void {
    const a = this.restAngle0 + this.body.rotationRate * this.state.t;
    const up = fromAngle(a);
    const rMag = this.body.radius + this.comAboveGroundStatic();
    this.state.r = scale(up, rMag);
    this.state.v = scale(perp(up), this.body.rotationRate * rMag);
    this.state.theta = a;
    this.state.omega = this.body.rotationRate;
  }

  /** comAboveGround without the massProps getter recursion at t=0. */
  private comAboveGroundStatic(): number {
    const stage = this.vehicle.stages[this.stageIndex];
    const full = stage ? stagePropellant(stage) : 0;
    const props = massProperties(this.geom, this.stageIndex, full > 0 ? this.propellant / full : 0, this.torn);
    return props.yCoM - this.attachedBottomY();
  }

  /** Surface regime: burn propellant, spool engines, release on TWR > 1. */
  private stepSurface(dt: number): number {
    const stage = this.vehicle.stages[this.stageIndex];
    const p = this.body.atmosphere?.pressure(Math.max(0, this.altitude)) ?? 0;
    const cmd = this.burning ? this.throttle : 0;
    this.actualThrottle += ((cmd - this.actualThrottle) / SPOOL_TAU) * dt;
    if (this.actualThrottle < 1e-4 && cmd === 0) this.actualThrottle = 0;
    let mdot = 0;
    let thrust = 0;
    if (stage && this.actualThrottle > 0 && this.propellant > 0) {
      mdot = stageMassFlow(stage) * this.actualThrottle;
      thrust = stageThrustAtPressure(stage, p) * this.actualThrottle;
    }
    this.state.m -= mdot * dt;
    this.propellant = Math.max(0, this.propellant - mdot * dt);
    this.state.t += dt;
    this.q = 0;
    this.mach = 0;
    const weight = (this.state.m * this.body.mu) / (this.body.radius * this.body.radius);
    if (thrust > weight) {
      this.landed = false;
      this.events.push({ type: 'liftoff', t: this.state.t });
    } else {
      this.pinToSurface();
    }
    return dt;
  }

  private stepPowered(dt: number): number {
    const stage = this.vehicle.stages[this.stageIndex];
    const atm = this.body.atmosphere;
    const p = atm ? atm.pressure(Math.max(0, this.altitude)) : 0;

    const cmd = this.burning ? this.throttle : 0;
    this.actualThrottle += ((cmd - this.actualThrottle) / SPOOL_TAU) * dt;
    if (this.actualThrottle < 1e-4 && cmd === 0) this.actualThrottle = 0;

    let mdot = 0;
    let thrust = 0;
    if (stage && this.actualThrottle > 0 && this.propellant > 0) {
      mdot = stageMassFlow(stage) * this.actualThrottle;
      thrust = stageThrustAtPressure(stage, p) * this.actualThrottle;
      if (mdot > 0) dt = Math.min(dt, Math.max(this.propellant / mdot, 1e-4));
    }

    const props = this.massProps;
    const lever = props.yCoM - this.attachedBottomY();

    // Attitude control: PD → gimbal + RCS.
    const err = wrapPi(this.targetAngle() - this.state.theta);
    const wantTorque = (KP * err - KD * this.state.omega) * props.inertia;
    let gimbalTorque = 0;
    if (thrust > 1 && lever > 0.1) {
      const s = Math.max(-1, Math.min(1, -wantTorque / (thrust * lever)));
      this.gimbal = Math.max(-GIMBAL_MAX, Math.min(GIMBAL_MAX, Math.asin(s)));
      gimbalTorque = -thrust * lever * Math.sin(this.gimbal);
    } else {
      this.gimbal = 0;
    }
    const rcsMax = this.vehicle.rcsTorque ?? 0;
    const controlTorque = gimbalTorque + Math.max(-rcsMax, Math.min(rcsMax, wantTorque - gimbalTorque));

    const cdA0 = this.vehicle.cd * this.vehicle.area;
    const refA = this.geom.refArea;
    const rotRate = this.body.rotationRate;
    const mu = this.body.mu;
    const bodyR = this.body.radius;
    const gimbal = this.gimbal;
    const chutes = this.activeChutes();
    const yCoM = props.yCoM;

    const deriv = (s: FlightState) => {
      const rn = norm(s.r);
      let acc = scale(s.r, -mu / (rn * rn * rn));
      let torque = controlTorque;
      const axis = fromAngle(s.theta);
      if (thrust > 0) acc = add(acc, scale(fromAngle(s.theta + gimbal), thrust / s.m));
      const h = rn - bodyR;
      if (atm && h < atm.topAltitude) {
        const air = sub(s.v, scale(perp(s.r), rotRate));
        const speed = norm(air);
        if (speed > 0.1) {
          const rho = atm.density(Math.max(0, h));
          const q = 0.5 * rho * speed * speed;
          // Axial drag with the transonic Cd rise.
          const cdA = cdA0 * machDragFactor(speed / speedOfSound(Math.max(0, h)));
          acc = add(acc, scale(air, (-q * cdA) / (speed * s.m)));
          // Parachutes: q·CdA opposite the airspeed at the riser height —
          // a canopy above the CoM is a restoring pendulum.
          for (const c of chutes) {
            const F = q * c.cdA;
            const Fx = (-F * air.x) / speed;
            const Fy = (-F * air.y) / speed;
            acc = add(acc, vec(Fx / s.m, Fy / s.m));
            // τ_z = (armY·axis) × F, force applied at the riser height.
            const armY = c.y - yCoM;
            torque += armY * (axis.x * Fy - axis.y * Fx);
          }
          if (props.cnAlpha > 0) {
            const aoa = Math.atan2(cross(air, axis), dot(air, axis));
            const N = q * refA * props.cnAlpha * Math.sin(aoa);
            acc = add(acc, scale(perp(axis), N / s.m));
            torque += N * (props.yCoP - yCoM);
            torque -= ((q * refA) / Math.max(speed, 20)) * props.dampingSum * s.omega;
          }
        }
      }
      return { dv: acc, domega: torque / props.inertia, dm: -mdot };
    };

    // Δv loss accounting: trapezoid over the step of the exact identity
    // d|v|/dt = T cosα/m − (−F_aero·v̂)/m − g sinγ.
    const pre = this.accountingIntegrands(thrust, gimbal, cdA0, chutes, props);
    this.state = rk4Step(this.state, dt, deriv);
    const post = this.accountingIntegrands(thrust, gimbal, cdA0, chutes, props);
    this.idealDv += (dt * (pre.ideal + post.ideal)) / 2;
    this.gravityLoss += (dt * (pre.grav + post.grav)) / 2;
    this.aeroLoss += (dt * (pre.aero + post.aero)) / 2;
    this.steeringLoss += (dt * (pre.steer + post.steer)) / 2;

    // Readouts.
    const air = this.airspeedVec;
    const speed = norm(air);
    const rho = atm ? atm.density(Math.max(0, this.altitude)) : 0;
    this.q = 0.5 * rho * speed * speed;
    this.mach = atm && this.altitude < 90_000 ? speed / speedOfSound(Math.max(0, this.altitude)) : 0;
    this.aoa = speed > 1 ? Math.atan2(cross(air, this.bodyAxis), dot(air, this.bodyAxis)) : 0;
    this.checkStructure();

    if (mdot > 0) {
      this.propellant = Math.max(0, this.propellant - mdot * dt);
      if (this.propellant === 0) {
        this.events.push({ type: 'stageBurnout', t: this.state.t, stage: this.stageIndex });
      }
    }
    this.checkContact();
    this.checkOrbit();
    return dt;
  }

  /** Integrands of the Δv budget at the current state (thrust fixed). */
  private accountingIntegrands(
    thrust: number,
    gimbal: number,
    cdA0: number,
    chutes: { cdA: number; y: number }[],
    props: MassProperties,
  ): { ideal: number; grav: number; aero: number; steer: number } {
    const s = this.state;
    const rn = norm(s.r);
    const vMag = norm(s.v);
    const vHat = vMag > 1e-9 ? scale(s.v, 1 / vMag) : vec(0, 0);
    const g = this.body.mu / (rn * rn);
    const sinGamma = vMag > 1e-9 ? dot(s.v, s.r) / (vMag * rn) : 0;
    const ideal = thrust / s.m;
    const tDir = fromAngle(s.theta + gimbal);
    const steer = vMag > 1e-9 ? (thrust / s.m) * (1 - dot(tDir, vHat)) : 0;
    // Total aero force (drag + chutes + normal), projected on v̂.
    let aeroAlong = 0;
    const atm = this.body.atmosphere;
    const h = rn - this.body.radius;
    if (atm && h < atm.topAltitude && vMag > 1e-9) {
      const air = this.airspeedVec;
      const speed = norm(air);
      if (speed > 0.1) {
        const q = 0.5 * atm.density(Math.max(0, h)) * speed * speed;
        const cdA = cdA0 * machDragFactor(speed / speedOfSound(Math.max(0, h)));
        const chuteA = chutes.reduce((sum, c) => sum + c.cdA, 0);
        let F = scale(air, (-q * (cdA + chuteA)) / speed);
        if (props.cnAlpha > 0) {
          const axis = fromAngle(s.theta);
          const aoa = Math.atan2(cross(air, axis), dot(air, axis));
          F = add(F, scale(perp(axis), q * this.geom.refArea * props.cnAlpha * Math.sin(aoa)));
        }
        aeroAlong = -dot(F, vHat) / s.m; // positive = loss
      }
    }
    return { ideal, grav: g * sinGamma, aero: aeroAlong, steer };
  }

  // ---------- structure, contact, termination ----------

  private attachedBottomY(): number {
    let y = Infinity;
    for (const p of this.geom.parts) {
      if (p.stage >= this.stageIndex && !this.torn.has(p.partId)) y = Math.min(y, p.y);
    }
    return isFinite(y) ? y : 0;
  }

  private attachedTopY(): number {
    let y = -Infinity;
    for (const p of this.geom.parts) {
      if (p.stage >= this.stageIndex && !this.torn.has(p.partId)) y = Math.max(y, p.y + p.height);
    }
    return isFinite(y) ? y : 0;
  }

  private halfWidth(): number {
    let w = 0.5;
    for (const p of this.geom.parts) {
      if (p.stage >= this.stageIndex && !this.torn.has(p.partId)) {
        w = Math.max(w, p.lateral + p.radius);
      }
    }
    return w;
  }

  private checkStructure(): void {
    if (this.q === 0 || this.crashed) return;
    for (const p of this.geom.parts) {
      if (p.stage < this.stageIndex || this.torn.has(p.partId)) continue;
      if (this.q > p.maxQ) {
        if (p.shedable) {
          this.torn.add(p.partId);
          this.state.m -= p.dryMass;
          this.events.push({ type: 'partTorn', t: this.state.t, partName: p.name });
        } else {
          this.crashed = true;
          this.events.push({ type: 'breakup', t: this.state.t, q: this.q });
          return;
        }
      }
    }
    // A deployed canopy tears if q climbs back over its envelope.
    if (this.chutesDeployed) {
      for (const c of this.geom.chutes) {
        if (c.stage >= this.stageIndex && !this.torn.has(c.partId) && this.q > c.safeQ) {
          this.torn.add(c.partId);
          this.events.push({ type: 'partTorn', t: this.state.t, partName: 'Parachute (over safe q)' });
        }
      }
    }
  }

  /**
   * Contact & touchdown adjudication. Four limits, each reported with the
   * measured value vs the limit when exceeded — "crashed" teaches nothing,
   * "vertical speed 11.4 m/s, limit 6.0" does.
   */
  private checkContact(): void {
    if (this.landed || this.crashed) return;
    if (this.altitude > this.geom.length * 2 + 200) return; // cheap far guard
    if (this.radarAltitude > 0) return;
    if (this.vSpeed < 0.1) return; // ascending or at rest at release — not contact

    const vs = this.vSpeed;
    const hs = this.hSpeed;
    const tilt = this.tilt;
    const footprint = this.legFootprint();
    const mode = footprint > 0 ? 'legs' : this.activeChutes().length > 0 ? 'chute' : 'none';
    const lim = TOUCHDOWN_LIMITS[mode];
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);

    const failures: string[] = [];
    if (vs > lim.vSpeed) failures.push(`vertical speed ${vs.toFixed(1)} m/s, limit ${lim.vSpeed.toFixed(1)}`);
    if (hs > lim.hSpeed) failures.push(`horizontal speed ${hs.toFixed(1)} m/s, limit ${lim.hSpeed.toFixed(1)}`);
    if (tilt > lim.tilt) failures.push(`tilt ${deg(tilt)}°, limit ${deg(lim.tilt)}°`);
    if (mode === 'legs') {
      // Tipping: CoM plumb line outside the leg footprint.
      const comH = this.comAboveGroundStatic();
      const comOffset = Math.tan(tilt) * comH;
      if (comOffset > footprint) {
        failures.push(`CoM ${comOffset.toFixed(1)} m outside the ${footprint.toFixed(1)} m leg footprint — tipped over`);
      }
    }

    if (failures.length === 0) {
      this.landed = true;
      this.hasLanded = true;
      // Freeze on the rotating surface at the contact point.
      this.restAngle0 = Math.atan2(this.state.r.y, this.state.r.x) - this.body.rotationRate * this.state.t;
      this.pinToSurface();
      this.throttle = 0;
      this.events.push({ type: 'landed', t: this.state.t, vSpeed: vs, hSpeed: hs, tilt });
    } else {
      this.crashed = true;
      this.events.push({ type: 'landingFailed', t: this.state.t, reason: failures.join('; ') });
    }
  }

  private checkOrbit(): void {
    if (!this.landed && !this.crashed && norm(this.state.r) < this.body.radius - 1) {
      // Below the datum with no adjudicated contact (e.g. steep lithobraking).
      this.crashed = true;
      this.events.push({ type: 'crash', t: this.state.t, speed: norm(this.airspeedVec) });
      return;
    }
    if (!this.inOrbit) {
      const el = this.elements;
      const clearance = this.body.atmosphere?.topAltitude ?? 0;
      if (el.e < 1 && el.rPeri > this.body.radius + clearance) {
        this.inOrbit = true;
        this.events.push({ type: 'orbit', t: this.state.t });
      }
    }
  }
}

export function wrapPi(a: number): number {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}
