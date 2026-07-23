// Finite-wing aero: pinned against analytic results from the cited
// sources (Anderson, Hoerner, Glauert/Nelson), the compile-time class
// gate, and a full-sim trim test — a 737-class plane holds level flight
// with the elevator alone, no autopilot.

import { describe, expect, it } from 'vitest';
import {
  A0,
  ELEV_MAX,
  FLAT_PLATE_CN,
  STALL_BLEND,
  flapEffectiveness,
  liftSlope,
  meanAeroChord,
  stallAngle,
  surfaceCoefficients,
} from './aero';
import { planeStability } from './massmodel';
import { LiftingSurface, Vehicle } from './vehicle';
import { Sim } from './sim';
import { dot, norm, scale, vec } from './vec2';
import { compile } from '../craft/compile';
import { referenceCraft } from '../craft/craft';

describe('finite-wing formulas (textbook pins)', () => {
  it('Prandtl slope: AR 8, e 0.8 → a = 4.787 rad⁻¹ (Anderson eq. 5.70)', () => {
    const a = liftSlope(8, 0.8);
    expect(a).toBeCloseTo(A0 / (1 + A0 / (Math.PI * 0.8 * 8)), 9);
    expect(a).toBeCloseTo(4.787, 3);
  });

  it('Helmbold slope (AR < 4) is below the Prandtl value and positive', () => {
    // Concorde-class delta: AR 1.83, e 0.55.
    const helmbold = liftSlope(1.83, 0.55);
    const prandtlWould = A0 / (1 + A0 / (Math.PI * 0.55 * 1.83));
    expect(helmbold).toBeGreaterThan(0);
    expect(helmbold).toBeLessThan(prandtlWould);
    // As AR → 0 Helmbold tends to the slender-wing limit π·e·AR/2.
    expect(liftSlope(0.5, 1)).toBeCloseTo((Math.PI * 0.5) / 2, 1);
  });

  it('induced drag: Cl = 1 at AR 9.45, e 0.8 → Cd_i = 0.0421 (Anderson eq. 5.61)', () => {
    const a = liftSlope(9.45, 0.8);
    const { cd } = surfaceCoefficients(1 / a, a, 9.45, 0.8, 2, 0);
    expect(cd).toBeCloseTo(1 / (Math.PI * 0.8 * 9.45), 6);
    expect(cd).toBeCloseTo(0.0421, 4);
  });

  it('(L/D)max = ½·√(π·e·AR/Cd0) (Anderson, Aircraft Perf. & Design eq. 5.30)', () => {
    const ar = 8;
    const e = 0.8;
    const cd0 = 0.02;
    const a = liftSlope(ar, e);
    let best = 0;
    for (let alpha = 0.001; alpha < 0.3; alpha += 0.0005) {
      const { cl, cd } = surfaceCoefficients(alpha, a, ar, e, 2, cd0);
      best = Math.max(best, cl / cd);
    }
    const theory = 0.5 * Math.sqrt((Math.PI * e * ar) / cd0);
    expect(theory).toBeCloseTo(15.85, 2);
    expect(Math.abs(best - theory) / theory).toBeLessThan(0.01);
  });

  it('stall: Cl is continuous through the blend and drops to the flat plate', () => {
    const ar = 8;
    const e = 0.8;
    const clMax = 1.4;
    const a = liftSlope(ar, e);
    const aStall = stallAngle(clMax, a);
    expect(aStall).toBeCloseTo(1.4 / 4.787, 3);
    // Continuity: no jump larger than the local slope allows.
    let prev = surfaceCoefficients(0, a, ar, e, clMax, 0.008).cl;
    for (let alpha = 1e-4; alpha < 0.8; alpha += 1e-4) {
      const { cl } = surfaceCoefficients(alpha, a, ar, e, clMax, 0.008);
      expect(Math.abs(cl - prev)).toBeLessThan(0.005);
      prev = cl;
    }
    // Past the blend: flat-plate values, less lift than Cl_max.
    const post = surfaceCoefficients(aStall + STALL_BLEND + 0.05, a, ar, e, clMax, 0.008);
    expect(post.cl).toBeLessThan(clMax);
    // At 90°: no lift, drag = Cd0 + 1.98 (plate normal to stream, Hoerner).
    const broadside = surfaceCoefficients(Math.PI / 2, a, ar, e, clMax, 0.008);
    expect(broadside.cl).toBeCloseTo(0, 6);
    expect(broadside.cd).toBeCloseTo(0.008 + FLAT_PLATE_CN, 6);
    // Odd symmetry: negative α mirrors.
    const neg = surfaceCoefficients(-0.1, a, ar, e, clMax, 0.008);
    const pos = surfaceCoefficients(0.1, a, ar, e, clMax, 0.008);
    expect(neg.cl).toBeCloseTo(-pos.cl, 9);
    expect(neg.cd).toBeCloseTo(pos.cd, 9);
  });

  it('flap effectiveness: τ(cf/c = 0.30) = 0.661 (Glauert; Anderson §4.9)', () => {
    expect(flapEffectiveness(0.3)).toBeCloseTo(0.661, 3);
    expect(flapEffectiveness(0)).toBeCloseTo(0, 6);
    expect(flapEffectiveness(1)).toBeCloseTo(1, 6);
  });

  it('trapezoid MAC (Raymer §4.2)', () => {
    // 737-800-ish: cr 7.88, ct 1.25 → MAC ≈ 5.35 m... simple known case:
    expect(meanAeroChord(2, 2)).toBeCloseTo(2, 9); // rectangular wing: MAC = c
    expect(meanAeroChord(3, 0)).toBeCloseTo(2, 9); // pure triangle: (2/3)·cr
  });
});

describe('neutral point aggregation', () => {
  const wing: LiftingSurface = {
    S: 124.6, AR: 9.45, a: liftSlope(9.45, 0.8), e: 0.8,
    incidence: 0.0349, y: 19, clMax: 1.4, cd0: 0.008,
  };
  const noBody = { mass: 60_000, yCoM: 17.2, inertia: 5e6, cnAlpha: 0, yCoP: NaN, dampingSum: 0, staticMarginCal: NaN };

  it('a lone wing puts the NP at its quarter-MAC', () => {
    const st = planeStability(noBody, 0, { surfaces: [wing], mac: 4.17, elevMax: ELEV_MAX });
    expect(st.yNP).toBeCloseTo(19, 9);
    // CoM at 17.2, NP at 19 (ahead of CoM): unstable, negative margin.
    expect(st.staticMarginPctMAC).toBeLessThan(0);
  });

  it('an aft tail pulls the NP aft and can stabilize', () => {
    const tail: LiftingSurface = {
      S: 32.8, AR: 6.27, a: liftSlope(6.27, 0.7), e: 0.7,
      incidence: -0.0349, y: 2, clMax: 1.2, cd0: 0.008,
      tau: flapEffectiveness(0.3),
      downwash: 1 - (2 * wing.a) / (Math.PI * wing.AR),
    };
    const st = planeStability(noBody, 0, { surfaces: [wing, tail], mac: 4.17, elevMax: ELEV_MAX });
    expect(st.yNP).toBeLessThan(19);
    expect(st.staticMarginPctMAC).toBeGreaterThan(0); // NP aft of the 17.2 CoM
    // Hand aggregation: (a_w·S_w·y_w + a_t_eff·S_t·y_t)/(a_w·S_w + a_t_eff·S_t).
    const aT = tail.a * tail.downwash!;
    const expected = (wing.a * wing.S * 19 + aT * tail.S * 2) / (wing.a * wing.S + aT * tail.S);
    expect(st.yNP).toBeCloseTo(expected, 9);
  });
});

describe('the class gate', () => {
  it('rockets never compile planeAero (byte-identical physics guarantee)', () => {
    expect(compile(referenceCraft()).vehicle.planeAero).toBeUndefined();
  });

  it('a plane-class craft gets planeAero even with zero wings — the class gates, not the parts', () => {
    const craft = referenceCraft();
    craft.vehicleClass = 'plane';
    const c = compile(craft);
    expect(c.vehicle.planeAero).toBeDefined();
    expect(c.vehicle.planeAero!.surfaces).toHaveLength(0);
  });
});

describe('trim (full sim, no autopilot)', () => {
  it('a 737-class plane holds commanded pitch in level flight on elevator alone', () => {
    // Hand-built plane: 60 t, 34.4 m fuselage (CoM mid-body at 17.2 m),
    // 737-800 wing (S 124.6 m², AR 9.45 — Boeing published planform),
    // horizontal tail (S 32.8 m², AR 6.27 — 737 tailplane class), static
    // margin ≈ +10% MAC. Thrust ≈ trim drag; Isp is synthetic-high so
    // the mass stays put (this pins trim, not propulsion).
    const wing: LiftingSurface = {
      S: 124.6, AR: 9.45, a: liftSlope(9.45, 0.8), e: 0.8,
      incidence: 2 * (Math.PI / 180), y: 19, clMax: 1.4, cd0: 0.008,
    };
    const tail: LiftingSurface = {
      S: 32.8, AR: 6.27, a: liftSlope(6.27, 0.7), e: 0.7,
      incidence: -2 * (Math.PI / 180), y: 2, clMax: 1.2, cd0: 0.008,
      tau: flapEffectiveness(0.3),
      downwash: 1 - (2 * liftSlope(9.45, 0.8)) / (Math.PI * 9.45),
    };
    const vehicle: Vehicle = {
      stages: [{
        engines: [{
          engine: {
            id: 'trim-jet', name: 'Trim thruster', propellant: 'kerolox',
            thrustSL: 50_000, thrustVac: 50_000, ispSL: 10_000, ispVac: 10_000,
            mass: 0, vacuumOnly: false, source: 'synthetic trim-test thruster',
            throttleable: true, minThrottle: 0.05, ignitions: Infinity,
            gimbalDeg: 0, expansionRatio: 1, maxAmbientPressure: Infinity,
            ullageImmune: true,
          },
          count: 1,
        }],
        tanks: [{ id: 'ft', name: 'Fuel', fluid: 'kerolox', volume: 6, propellantMass: 5_000, dryMass: 0, source: 'synthetic' }],
        extraDryMass: 55_000,
      }],
      payloadMass: 0,
      cd: 0.1,
      area: 12,
      geometry: {
        parts: [{
          partId: 'fus', name: 'Fuselage', stage: 0, y: 0, height: 34.4,
          radius: 1.85, lateral: 0, dryMass: 55_000, propellant: 5_000,
          cnAlpha: 0, yCp: 0, maxQ: 60_000, shedable: false,
        }],
        refDiameter: 3.7,
        refArea: Math.PI * 1.85 * 1.85,
        length: 34.4,
        legs: [],
        chutes: [],
      },
      planeAero: { surfaces: [wing, tail], mac: 4.17, elevMax: ELEV_MAX },
    };
    const sim = new Sim(vehicle);
    // Level flight at 5 km, 220 m/s airspeed eastward.
    const r = sim.body.radius + 5_000;
    sim.landed = false;
    sim.state = {
      r: vec(r, 0),
      v: vec(0, sim.body.rotationRate * r + 220),
      theta: Math.PI / 2, // nose on the horizon
      omega: 0,
      m: sim.state.m,
      t: 0,
    };
    // Commanded pitch just above the horizon (trim α ≈ 0.7°).
    sim.attitude = { mode: 'pitch', angle: Math.PI / 2 - 0.009 };
    sim.throttle = 1;
    let maxOmegaLate = 0;
    for (let i = 0; i < 2_400; i++) {
      sim.step(0.05);
      if (i > 1_200) maxOmegaLate = Math.max(maxOmegaLate, Math.abs(sim.state.omega));
    }
    expect(sim.crashed).toBe(false);
    // Trim achieved: rate damped out, elevator well inside its throw,
    // wings unstalled. This pins ATTITUDE trim — a fixed hand-picked
    // pitch won't hold energy exactly, so the altitude check is a
    // shallow-flight-path bound, not a tight box.
    expect(maxOmegaLate).toBeLessThan(1e-3);
    expect(Math.abs(sim.elevator)).toBeLessThan(0.8 * ELEV_MAX);
    expect(sim.stallMargin).toBeGreaterThan(0);
    const rHat = scale(sim.state.r, 1 / norm(sim.state.r));
    const vSpeed = dot(sim.state.v, rHat);
    expect(Math.abs(vSpeed)).toBeLessThan(20); // flight path within ~5° of level
    expect(sim.altitude).toBeGreaterThan(3_000);
    expect(sim.altitude).toBeLessThan(8_000);
  });
});
