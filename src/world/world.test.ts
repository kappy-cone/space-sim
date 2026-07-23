// World state model tests: the session gate, save versioning, on-demand
// analytic propagation, decay-as-GC, station-keeping life, and the
// committed-flight harvest. The load-bearing regression: an empty world
// changes nothing — the Sim never reads world state, and a flight at the
// default start time is byte-identical to the pre-world sim (the golden
// fixtures pin the trajectories themselves).

import { describe, expect, it } from 'vitest';
import { compile } from '../craft/compile';
import { referenceCraft } from '../craft/craft';
import { Autopilot, defaultPlan } from '../physics/autopilot';
import { EARTH } from '../physics/bodies';
import { density } from '../physics/atmosphere';
import { elementsFromState, propagateKepler } from '../physics/kepler';
import { Sim } from '../physics/sim';
import { vec } from '../physics/vec2';
import { advanceDecay, perOrbitDrag } from './decay';
import {
  ascentDirection,
  corridorViolated,
  harvestCommittedFlight,
  restingRunwayOf,
} from './commit';
import { starterCrafts } from '../craft/craft';
import { siteById } from '../physics/sites';
import { activeFunc } from '../craft/compile';
import { addPart } from '../craft/craft';
import { closestApproach } from './rendezvous';
import { activateSite, siteAvailable, siteState } from './world';
import {
  SpaceObject,
  WorldState,
  advanceWorld,
  deserializeWorld,
  emptyWorld,
  isRevealed,
  objectStateAt,
  revealArc,
  revealedFraction,
  serializeWorld,
  stateFromElements,
} from './world';

/** Circular-orbit registry object at altitude h with ballistic term
 * cdA/m — the decay workhorse fixture. */
function circObject(h: number, cdAOverM: number, skProp = 0, mass = 1_000): SpaceObject {
  const r = EARTH.radius + h;
  const v = Math.sqrt(EARTH.mu / r);
  return {
    id: 'T-1',
    name: 'test object',
    kind: skProp > 0 ? 'satellite' : 'debris',
    body: 'earth',
    r: [r, 0],
    v: [0, v],
    t0: 0,
    mass,
    skProp,
    cdA: cdAOverM * mass,
    launch: 0,
  };
}

describe('save format', () => {
  it('round-trips and carries a version', () => {
    const w = emptyWorld();
    w.epoch = 12_345;
    w.objects.push(circObject(400_000, 0.004));
    const back = deserializeWorld(serializeWorld(w));
    expect(back).toEqual(w);
    expect(back!.version).toBe(1);
  });

  it('rejects corrupt saves without throwing, refuses future versions', () => {
    expect(deserializeWorld('not json')).toBeNull();
    expect(deserializeWorld('42')).toBeNull();
    expect(() => deserializeWorld(JSON.stringify({ ...emptyWorld(), version: 99 }))).toThrow();
  });
});

describe('the session gate', () => {
  it('a sim at the default start time is byte-identical with and without a world existing', () => {
    // The Sim takes no world input at all — construct two, one while a
    // populated world object exists, step both identically, compare the
    // full state. This pins the architecture: flights read nothing.
    const vehicle = compile(referenceCraft()).vehicle;
    const a = new Sim(vehicle);
    const w = emptyWorld();
    w.objects.push(circObject(200_000, 0.01));
    advanceWorld(w, 3_600);
    const b = new Sim(vehicle);
    for (let i = 0; i < 400; i++) {
      a.throttle = 1;
      b.throttle = 1;
      a.step(0.25);
      b.step(0.25);
    }
    expect(b.state).toEqual(a.state);
    expect(b.pools).toEqual(a.pools);
  });

  it('a committed flight launched at a nonzero world epoch still reaches orbit', () => {
    // Epoch continuity: the pad has rotated for three days; the pin,
    // autopilot, and orbit adjudication must all be t-parameterized.
    const vehicle = compile(referenceCraft()).vehicle;
    const t0 = 3 * 86_400;
    const sim = new Sim(vehicle, EARTH, undefined, undefined, t0);
    expect(sim.state.t).toBe(t0);
    const ap = new Autopilot(defaultPlan(250_000, sim.body));
    const atmTop = sim.body.atmosphere!.topAltitude;
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < t0 + 8_000) {
      ap.update(sim);
      const coasting = !sim.burning && sim.actualThrottle < 0.01 && sim.altitude > atmTop;
      sim.step(coasting ? Math.max(1, sim.elements.timeToApo / 20) : 0.25);
    }
    expect(ap.phase).toBe('done');
    expect(sim.inOrbit).toBe(true);
  });
});

describe('registry propagation', () => {
  it('is exact two-body and mutates nothing', () => {
    const o = circObject(400_000, 0.004);
    const before = JSON.stringify(o);
    const t = 5_000;
    const s = objectStateAt(o, t);
    const direct = propagateKepler(vec(o.r[0], o.r[1]), vec(o.v[0], o.v[1]), t, EARTH.mu);
    expect(s.r.x).toBeCloseTo(direct.r.x, 6);
    expect(s.v.y).toBeCloseTo(direct.v.y, 9);
    expect(JSON.stringify(o)).toBe(before); // a pure read
  });

  it('stateFromElements round-trips through elementsFromState, both directions', () => {
    for (const dir of [1, -1] as const) {
      const a = 8_000_000;
      const e = 0.2;
      const argPeri = 0.7;
      const nu = 1.1;
      const s = stateFromElements(a, e, argPeri, dir, nu, EARTH.mu);
      const el = elementsFromState(s.r, s.v, EARTH.mu);
      expect(el.a).toBeCloseTo(a, 3);
      expect(el.e).toBeCloseTo(e, 9);
      expect(el.nu).toBeCloseTo(nu, 9);
      expect(Math.sign(el.h)).toBe(dir);
      expect(((el.argPeri - argPeri) % (2 * Math.PI))).toBeCloseTo(0, 6);
    }
  });
});

describe('atmospheric decay', () => {
  it('matches the classical circular-orbit decay rate Δa = −2π·(CdA/m)·ρ·a² per revolution', () => {
    // King-Hele / Vallado §9.6 closed form for a circular orbit.
    const h = 400_000;
    const a0 = EARTH.radius + h;
    const B = 0.004; // CdA/m ≈ ISS class (Cd 2.2, A/m ~0.002 m²/kg)
    const T = 2 * Math.PI * Math.sqrt((a0 * a0 * a0) / EARTH.mu);
    const res = advanceDecay({ a: a0, e: 0 }, B, T, EARTH.mu, EARTH.radius);
    const expected = 2 * Math.PI * B * density(h) * a0 * a0;
    expect(res.reentered).toBe(false);
    expect(a0 - res.a).toBeGreaterThan(expected * 0.97);
    expect(a0 - res.a).toBeLessThan(expected * 1.03);
    // Sanity anchor: ISS-class decay ≈ metres per orbit / ~2 km per month.
    expect(a0 - res.a).toBeGreaterThan(1);
    expect(a0 - res.a).toBeLessThan(20);
  });

  it('low objects reenter and are removed — the registry is garbage-collected', () => {
    const w = emptyWorld();
    w.objects.push(circObject(150_000, 0.01));
    const events = advanceWorld(w, 5 * 86_400);
    expect(w.objects.length).toBe(0);
    expect(events.some((e) => e.type === 'reentry')).toBe(true);
    expect(w.log.some((e) => e.type === 'reentry')).toBe(true);
    expect(w.epoch).toBe(5 * 86_400);
  });

  it('objects clear of the atmosphere are untouched — stored state stays exact', () => {
    const w = emptyWorld();
    const geo = circObject(35_786_000, 0.004); // GEO altitude (real value)
    const frozen = JSON.parse(JSON.stringify(geo)) as SpaceObject;
    w.objects.push(geo);
    advanceWorld(w, 30 * 86_400);
    expect(w.objects[0]).toEqual(frozen); // t0 and state vector untouched
  });

  it('perOrbitDrag reduces to zero above the density table', () => {
    const a = EARTH.radius + 2_000_000;
    const d = perOrbitDrag(a, 0, EARTH.mu, EARTH.radius);
    expect(Math.abs(d.dE)).toBe(0);
    expect(Math.abs(d.dv)).toBe(0);
  });
});

describe('station-keeping', () => {
  it('propellant holds the orbit; depletion starts the decay; more propellant lives longer', () => {
    const mk = (prop: number): WorldState => {
      const w = emptyWorld();
      w.objects.push(circObject(300_000, 0.01, prop, 500));
      return w;
    };
    // Held: 30 days on a fat budget — semi-major axis unchanged (exact,
    // the stored state is never rebuilt while station-keeping holds).
    const held = mk(50);
    advanceWorld(held, 30 * 86_400);
    expect(held.objects.length).toBe(1);
    const elHeld = elementsFromState(
      vec(held.objects[0]!.r[0], held.objects[0]!.r[1]),
      vec(held.objects[0]!.v[0], held.objects[0]!.v[1]),
      EARTH.mu,
    );
    expect(elHeld.a).toBeCloseTo(EARTH.radius + 300_000, 3);
    expect(held.objects[0]!.skProp).toBeLessThan(50); // it cost something
    expect(held.objects[0]!.skProp).toBeGreaterThan(0);

    // Depleted: a 1 kg budget runs out and decay takes over.
    const starved = mk(1);
    const events = advanceWorld(starved, 30 * 86_400);
    expect(events.some((e) => e.type === 'skDepleted')).toBe(true);
    const o = starved.objects[0]!;
    const elStarved = elementsFromState(vec(o.r[0], o.r[1]), vec(o.v[0], o.v[1]), EARTH.mu);
    expect(elStarved.a).toBeLessThan(elHeld.a - 1_000); // visibly decayed
  });
});

describe('terrain reveal bitfield', () => {
  it('reveals arcs, wraps the seam, survives a save round-trip', () => {
    const w = emptyWorld();
    expect(revealedFraction(w)).toBe(0);
    revealArc(w, -0.1, 0.2); // straddles angle 0
    expect(isRevealed(w, 0)).toBe(true);
    expect(isRevealed(w, 0.05)).toBe(true);
    expect(isRevealed(w, Math.PI)).toBe(false);
    const back = deserializeWorld(serializeWorld(w))!;
    expect(isRevealed(back, 0.05)).toBe(true);
    expect(revealedFraction(back)).toBeCloseTo(revealedFraction(w), 12);
  });
});

describe('satellites', () => {
  it('a function module classifies the compiled craft and survives staging bookkeeping', () => {
    const craft = referenceCraft();
    addPart(craft, 'root', 'sat-relay', { kind: 'radial', angle: 0.4, y: 1.0 });
    const c = compile(craft);
    expect(c.funcModules.length).toBe(1);
    // The module rides the top section (last burn index): active from
    // stage 0 through the final stack.
    expect(activeFunc(c, 0)).toBe('relay');
    expect(activeFunc(c, c.stages.length - 1)).toBe('relay');
  });

  it('a deployed relay is harvested as a satellite with its function', () => {
    const craft = referenceCraft();
    addPart(craft, 'root', 'sat-relay', { kind: 'radial', angle: 0.4, y: 1.0 });
    const compiled = compile(craft);
    const sim = new Sim(compiled.vehicle);
    // Plant it directly in a stable orbit (the ascent is tested elsewhere).
    const r = EARTH.radius + 500_000;
    sim.landed = false;
    sim.stageIndex = compiled.stages.length - 1;
    sim.state = { ...sim.state, r: vec(r, 0), v: vec(0, Math.sqrt(EARTH.mu / r)) };
    const w = emptyWorld();
    harvestCommittedFlight(w, [{ sim, name: 'Relay 1', func: activeFunc(compiled, sim.stageIndex) }], {
      siteId: 'pad-1',
      launchName: 'Relay 1',
    });
    const sat = w.objects.find((o) => o.kind === 'satellite');
    expect(sat).toBeDefined();
    expect(sat!.func).toBe('relay');
    expect(sat!.skProp).toBeGreaterThan(0); // residual RCS budget = station-keeping life
  });

  it('closestApproach finds a designed perigee intercept', () => {
    // Target: circular at r1. Vessel: ellipse with perigee r1, apogee
    // r2, at apoapsis now; the target is phased to arrive at the
    // vessel's perigee point exactly half a vessel-period from now.
    const r1 = EARTH.radius + 400_000;
    const r2 = EARTH.radius + 1_200_000;
    const a = (r1 + r2) / 2;
    const Tv = 2 * Math.PI * Math.sqrt((a * a * a) / EARTH.mu);
    const nT = Math.sqrt(EARTH.mu / (r1 * r1 * r1)); // target mean motion
    // Vessel at apoapsis on +x; perigee at angle π. Target must be at
    // angle π − nT·(Tv/2) now.
    const phi0 = Math.PI - nT * (Tv / 2);
    const target: SpaceObject = {
      id: 'D-1',
      name: 'debris',
      kind: 'debris',
      body: 'earth',
      r: [r1 * Math.cos(phi0), r1 * Math.sin(phi0)],
      v: [-Math.sqrt(EARTH.mu / r1) * Math.sin(phi0), Math.sqrt(EARTH.mu / r1) * Math.cos(phi0)],
      t0: 0,
      mass: 2_000,
      skProp: 0,
      cdA: 5,
      launch: 0,
    };
    const vApo = Math.sqrt(EARTH.mu * (2 / r2 - 1 / a));
    const res = closestApproach(vec(r2, 0), vec(0, vApo), target, 0, 2 * Tv);
    expect(res.dist).toBeLessThan(1_000); // metres-class miss at the designed node
    expect(Math.abs(res.dt - Tv / 2)).toBeLessThan(30);
    expect(res.relSpeed).toBeGreaterThan(100); // real intercepts arrive hot — braking is the tug's job
  });

  it('grappled objects leave the registry at commit', () => {
    const compiled = compile(referenceCraft());
    const sim = new Sim(compiled.vehicle);
    const r = EARTH.radius + 500_000;
    sim.landed = false;
    sim.state = { ...sim.state, r: vec(r, 0), v: vec(0, Math.sqrt(EARTH.mu / r)) };
    const w = emptyWorld();
    w.objects.push(circObject(400_000, 0.004));
    const res = harvestCommittedFlight(
      w,
      [{ sim, name: 'Tug 1', capturedIds: ['T-1'] }],
      { siteId: 'pad-1', launchName: 'Tug 1' },
    );
    expect(w.objects.find((o) => o.id === 'T-1')).toBeUndefined();
    expect(res.events.some((e) => e.type === 'deorbited')).toBe(true);
  });
});

describe('committed-flight harvest', () => {
  it('a flown ascent writes the vessel to the registry, drops suborbital stages, advances the clock', () => {
    const compiled = compile(referenceCraft());
    const sim = new Sim(compiled.vehicle);
    const ap = new Autopilot(defaultPlan(250_000, sim.body));
    const atmTop = sim.body.atmosphere!.topAltitude;
    while (ap.phase !== 'done' && ap.phase !== 'failed' && sim.state.t < 8_000) {
      ap.update(sim);
      const coasting = !sim.burning && sim.actualThrottle < 0.01 && sim.altitude > atmTop;
      sim.step(coasting ? Math.max(1, sim.elements.timeToApo / 20) : 0.25);
    }
    expect(sim.inOrbit).toBe(true);
    expect(sim.sepStates.length).toBeGreaterThan(0); // stage 1 was dropped

    const w = emptyWorld();
    const res = harvestCommittedFlight(w, [{ sim, name: 'Reference' }], {
      siteId: 'pad-1',
      launchName: 'Reference',
    });
    // The orbiting upper stack persists as a vessel…
    const vessel = w.objects.find((o) => o.kind === 'vessel');
    expect(vessel).toBeDefined();
    expect(vessel!.mass).toBeCloseTo(sim.state.m, 9);
    // …and the first stage, dropped suborbital, does NOT enter the registry.
    const sepEl = elementsFromState(sim.sepStates[0]!.r, sim.sepStates[0]!.v, EARTH.mu);
    expect(sepEl.rPeri).toBeLessThan(EARTH.radius); // it really was suborbital
    expect(w.objects.some((o) => o.kind === 'debris')).toBe(false);
    expect(w.launches).toBe(1);
    expect(w.epoch).toBe(sim.state.t);
    expect(res.events.some((e) => e.type === 'deployed')).toBe(true);
    // The whole thing survives a save round-trip.
    expect(deserializeWorld(serializeWorld(w))).toEqual(w);
  });

  it('launching wears the pad and blocks it until the reset elapses', () => {
    const compiled = compile(referenceCraft());
    const sim = new Sim(compiled.vehicle);
    sim.crashed = true; // outcome irrelevant — wear is about the departure
    sim.landed = false;
    const w = emptyWorld();
    harvestCommittedFlight(w, [{ sim, name: 'X' }], { siteId: 'pad-1', launchName: 'X' });
    expect(siteState(w, 'pad-1').wearUntil).toBeGreaterThan(0);
    expect(siteAvailable(w, 'pad-1')).toBe(false);
    // Heavier vehicles wear the pad longer — the quiet gentleness reward.
    advanceWorld(w, siteState(w, 'pad-1').wearUntil - w.epoch + 1);
    expect(siteAvailable(w, 'pad-1')).toBe(true);
  });

  it('a plane down on an unbuilt runway activates the site (and the pad it serves)', () => {
    const gull = starterCrafts().find((s) => s.name === 'Gull Trainer')!;
    const compiled = compile(gull.craft);
    // Pinned to the West Range strip at start — resting on the runway is
    // exactly the state a completed delivery flight ends in.
    const sim = new Sim(compiled.vehicle, undefined, siteById('runway-west'));
    expect(sim.landed).toBe(true);
    expect(restingRunwayOf(sim)?.id).toBe('runway-west');
    const w = emptyWorld();
    expect(siteAvailable(w, 'pad-west')).toBe(false);
    const res = harvestCommittedFlight(w, [{ sim, name: 'Ferry' }], {
      siteId: 'runway-1',
      launchName: 'Ferry',
    });
    expect(res.recovered).toEqual(['Ferry']);
    expect(siteState(w, 'runway-west').active).toBe(true);
    expect(siteState(w, 'pad-west').active).toBe(true); // the chain
    expect(w.log.some((e) => e.type === 'siteActivated')).toBe(true);
  });

  it('range corridors: direction detection and per-site legality', () => {
    const compiled = compile(referenceCraft());
    const sim = new Sim(compiled.vehicle);
    // Fabricate a downrange state: 10 km up, 800 m/s eastward inertial
    // (≈ 335 m/s over the rotating surface — clearly committed).
    const r = sim.body.radius + 10_000;
    sim.landed = false;
    sim.state = { ...sim.state, r: vec(r, 0), v: vec(0, 800) };
    expect(ascentDirection(sim)).toBe(1);
    sim.state = { ...sim.state, v: vec(0, -500) };
    expect(ascentDirection(sim)).toBe(-1);
    sim.state = { ...sim.state, v: vec(0, r * sim.body.rotationRate) }; // co-rotating: not committed
    expect(ascentDirection(sim)).toBe(0);
    expect(corridorViolated(siteById('pad-1'), -1)).toBe(true); // Cape flies east only
    expect(corridorViolated(siteById('pad-1'), 1)).toBe(false);
    expect(corridorViolated(siteById('pad-west'), 1)).toBe(true); // West Range flies west only
    expect(corridorViolated(siteById('runway-1'), -1)).toBe(false); // runways: both
  });

  it('activation chains are idempotent', () => {
    const w = emptyWorld();
    activateSite(w, 'runway-west', 100);
    const n = w.log.length;
    activateSite(w, 'runway-west', 200);
    expect(w.log.length).toBe(n); // nothing new
  });

  it('crashed vessels write nothing; landed vessels count as recovered', () => {
    const compiled = compile(referenceCraft());
    const crashed = new Sim(compiled.vehicle);
    crashed.crashed = true;
    const landed = new Sim(compiled.vehicle); // still pinned to the pad
    const w = emptyWorld();
    const res = harvestCommittedFlight(
      w,
      [
        { sim: crashed, name: 'Wreck' },
        { sim: landed, name: 'Carrier' },
      ],
      { siteId: 'pad-1', launchName: 'Wreck' },
    );
    expect(w.objects.length).toBe(0);
    expect(res.recovered).toEqual(['Carrier']);
  });
});
