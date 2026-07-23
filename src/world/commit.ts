// Harvest a COMMITTED flight into the world. This is the only path by
// which flying writes world state — test flights simply never call it.
//
// Admission rule: an object enters the registry iff its orbit persists
// (closed, periapsis above the reentry floor). Everything else either
// fell back inside the flight (suborbital stages litter the corridor and
// burn up — physically what happens to first stages) or escaped the SOI.
//
// The pre-existing registry ages by the flight's duration first, so a
// satellite decaying on the far side of the planet keeps decaying while
// you fly. World epoch continuity is exact: committed flights launch AT
// the world epoch (Sim startTime), so sep-state and final-state times
// are already world times.

import { Sim, TOUCHDOWN_LIMITS, wrapPi } from '../physics/sim';
import { elementsFromState } from '../physics/kepler';
import { bodyById } from '../physics/bodies';
import { SITES, Site, siteById } from '../physics/sites';
import { P0_SEA_LEVEL } from '../physics/constants';
import { stageThrustAtPressure } from '../physics/vehicle';
import { cross, norm } from '../physics/vec2';
import {
  SatelliteFunc,
  SpaceObject,
  WorldEvent,
  WorldState,
  activateSite,
  advanceWorld,
  applyWear,
  orbitPersists,
  padWearSeconds,
  pushLog,
  runwayWearSeconds,
} from './world';

/**
 * Downrange direction of flight relative to the rotating surface:
 * +1 east (prograde), −1 west (retrograde), 0 while effectively
 * stationary. The corridor adjudicator samples this once the vessel is
 * clearly downrange-committed.
 */
export function ascentDirection(sim: Sim): 1 | -1 | 0 {
  const air = sim.airspeedVec;
  const rn = norm(sim.state.r);
  if (rn < 1) return 0;
  const tangential = cross(sim.state.r, air) / rn; // + = east/prograde
  if (Math.abs(tangential) < 100) return 0; // not yet committed
  return tangential > 0 ? 1 : -1;
}

/** Does flying in direction `dir` from `site` violate its range-safety
 * corridor? (Runways are 'both' — aircraft turn back freely.) */
export function corridorViolated(site: Site, dir: 1 | -1 | 0): boolean {
  if (dir === 0) return false;
  return (site.corridor === 'east' && dir < 0) || (site.corridor === 'west' && dir > 0);
}

/** The runway a landed vessel is resting on, if any. */
export function restingRunwayOf(sim: Sim): Site | null {
  if (!sim.landed && !sim.hasLanded) return null;
  const surfA = Math.atan2(sim.state.r.y, sim.state.r.x) - sim.body.rotationRate * sim.state.t;
  return (
    SITES.find(
      (s) =>
        s.type === 'runway' &&
        s.body === sim.body.id &&
        Math.abs(wrapPi(surfA - s.angle)) * sim.body.radius <= (s.halfLength ?? 0),
    ) ?? null
  );
}

export interface HarvestVessel {
  sim: Sim;
  name: string;
  /** Function module aboard, if any — classifies the object a satellite. */
  func?: SatelliteFunc;
  /** Burn indices whose separation spawned a live vessel (release
   * pylons): their sepStates are skipped — the payload is harvested as
   * its own vessel, not as debris. */
  releasedStages?: number[];
  /** Registry ids this vessel grappled in flight (tug). At commit they
   * leave the registry — deorbited with the tug or riding attached (the
   * mass is already inside the vessel's final state). */
  capturedIds?: string[];
}

export interface HarvestResult {
  events: WorldEvent[];
  /** Objects added this launch (satellites, vessels, debris). */
  added: SpaceObject[];
  /** Vessels that ended the flight landed/recovered. */
  recovered: string[];
}

export function harvestCommittedFlight(
  w: WorldState,
  vessels: HarvestVessel[],
  opts: { siteId: string; launchName: string; rangeViolated?: boolean },
): HarvestResult {
  const launchEpoch = w.epoch;
  let tEnd = launchEpoch;
  for (const v of vessels) tEnd = Math.max(tEnd, v.sim.state.t);

  // Grappled objects leave the registry first (they were physically
  // grabbed mid-flight — their mass rides inside the tug's final state).
  const grabbed = new Set(vessels.flatMap((v) => v.capturedIds ?? []));
  const events: WorldEvent[] = [];
  if (grabbed.size > 0) {
    w.objects = w.objects.filter((o) => {
      if (!grabbed.has(o.id)) return true;
      const ev: WorldEvent = { type: 'deorbited', t: launchEpoch, id: o.id, name: o.name };
      events.push(ev);
      pushLog(w, ev);
      return false;
    });
  }

  // Age the pre-existing registry through the flight window.
  events.push(...advanceWorld(w, tEnd - launchEpoch));

  const n = ++w.launches;
  const launchEv: WorldEvent = { type: 'launch', t: launchEpoch, n, site: opts.siteId, name: opts.launchName };
  events.push(launchEv);
  pushLog(w, launchEv);

  // Launch-site wear: pads take refurbishment scaled by liftoff thrust;
  // a runway departure is one light cycle.
  const launchSite = siteById(opts.siteId);
  if (vessels.length > 0) {
    const v0 = vessels[0]!.sim.vehicle;
    const wear =
      launchSite.type === 'pad'
        ? padWearSeconds(v0.stages[0] ? stageThrustAtPressure(v0.stages[0], P0_SEA_LEVEL) : 0)
        : runwayWearSeconds(false);
    applyWear(w, opts.siteId, wear, launchEpoch);
  }
  if (opts.rangeViolated) {
    const ev: WorldEvent = { type: 'rangeViolation', t: launchEpoch, site: opts.siteId };
    events.push(ev);
    pushLog(w, ev);
  }

  const added: SpaceObject[] = [];
  const recovered: string[] = [];
  let seq = 0;
  const admit = (o: SpaceObject, ev: WorldEvent): void => {
    w.objects.push(o);
    added.push(o);
    events.push(ev);
    pushLog(w, ev);
  };

  for (const v of vessels) {
    const s = v.sim;
    // Spent stages → debris, where the orbit persists.
    for (const sep of s.sepStates) {
      if (v.releasedStages?.includes(sep.stage)) continue;
      const el = elementsFromState(sep.r, sep.v, bodyById(sep.body).mu);
      if (!orbitPersists(el, sep.body)) continue;
      const id = `L${n}-${++seq}`;
      admit(
        {
          id,
          name: `${v.name} stage ${sep.stage + 1}`,
          kind: 'debris',
          body: sep.body,
          r: [sep.r.x, sep.r.y],
          v: [sep.v.x, sep.v.y],
          t0: sep.t,
          mass: sep.mass,
          skProp: 0,
          cdA: sep.cdA,
          launch: n,
        },
        { type: 'debris', t: sep.t, id, name: `${v.name} stage ${sep.stage + 1}` },
      );
    }
    if (s.crashed) continue;
    if (s.landed || s.hasLanded) {
      recovered.push(v.name);
      // A plane down on a runway is a delivery flight: wear the strip
      // (harder if the touchdown was rough), and if the field was not
      // yet built out, this landing IS the hardware arriving — activate
      // it (and the pad it serves).
      const rw = restingRunwayOf(s);
      if (rw && s.vehicle.planeAero) {
        const touchdown = [...s.events].reverse().find((e) => e.type === 'landed');
        const hard =
          touchdown?.type === 'landed' && touchdown.vSpeed > 0.7 * TOUCHDOWN_LIMITS.runway.vSpeed;
        applyWear(w, rw.id, runwayWearSeconds(!!hard), s.state.t);
        events.push(...activateSite(w, rw.id, s.state.t));
      }
      continue;
    }
    const el = elementsFromState(s.state.r, s.state.v, s.body.mu);
    if (!orbitPersists(el, s.body.id)) continue;
    // Residual propellant aboard becomes the station-keeping budget —
    // lifetime falls out of the tanks the player fitted, not a timer.
    // Simplification (flagged): all residual fluids count at the same
    // storable-RCS Isp 300 s the sim's RCS model uses.
    let residual = s.rcsPropellant;
    for (let i = s.stageIndex; i < s.pools.length; i++) residual += s.pools[i] ?? 0;
    const drag = s.vehicle.drag;
    const di = Math.min(s.stageIndex, (drag?.cdBare.length ?? 1) - 1);
    const id = `L${n}-${++seq}`;
    admit(
      {
        id,
        name: v.name,
        kind: v.func ? 'satellite' : 'vessel',
        func: v.func,
        body: s.body.id,
        r: [s.state.r.x, s.state.r.y],
        v: [s.state.v.x, s.state.v.y],
        t0: s.state.t,
        mass: s.state.m,
        skProp: residual,
        cdA: drag ? drag.cdBare[di]! * drag.areaBare[di]! : s.vehicle.cd * s.vehicle.area,
        launch: n,
      },
      { type: 'deployed', t: s.state.t, id, name: v.name, func: v.func },
    );
  }
  return { events, added, recovered };
}
