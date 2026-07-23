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

import { Sim } from '../physics/sim';
import { elementsFromState } from '../physics/kepler';
import { bodyById } from '../physics/bodies';
import {
  SatelliteFunc,
  SpaceObject,
  WorldEvent,
  WorldState,
  advanceWorld,
  orbitPersists,
  pushLog,
} from './world';

export interface HarvestVessel {
  sim: Sim;
  name: string;
  /** Function module aboard, if any — classifies the object a satellite. */
  func?: SatelliteFunc;
  /** Burn indices whose separation spawned a live vessel (release
   * pylons): their sepStates are skipped — the payload is harvested as
   * its own vessel, not as debris. */
  releasedStages?: number[];
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
  opts: { siteId: string; launchName: string },
): HarvestResult {
  const launchEpoch = w.epoch;
  let tEnd = launchEpoch;
  for (const v of vessels) tEnd = Math.max(tEnd, v.sim.state.t);

  // Age the pre-existing registry through the flight window first.
  const events: WorldEvent[] = advanceWorld(w, tEnd - launchEpoch);

  const n = ++w.launches;
  const launchEv: WorldEvent = { type: 'launch', t: launchEpoch, n, site: opts.siteId, name: opts.launchName };
  events.push(launchEv);
  pushLog(w, launchEv);

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
