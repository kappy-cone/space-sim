// The demand model: the world periodically wants a thing in a
// particular orbit by a particular date. That is the whole model — no
// currency, no contracts, no tech tree; the reward is the program
// record. Missions are declarative constraint sets (function, orbit
// band, direction, deadline) adjudicated against the registry.
//
// Generation is DETERMINISTIC: a counter-seeded PRNG (mulberry32 — the
// sim allows no Math.random in world/physics code), driven by world
// state. What the world asks for tracks what the program lacks:
// no relay coverage → relay wants; unmapped terrain → survey wants
// (retrograde after the first — the SSO-analogue demand direction that
// forces the west corridor); crowded bands → tug wants naming a real
// piece of junk; a working program → the Moon, where far-side ops need
// the relay you launched on an earlier flight.

import { EARTH } from '../physics/bodies';
import { constellationAltitude } from './network';
import {
  MissionRecord,
  SURVEY_CEILING,
  WorldEvent,
  WorldState,
  objectElements,
  pushLog,
  revealedFraction,
} from './world';

export const MAX_OPEN_MISSIONS = 3;

/** GEO altitude [m] — a planar synchronous orbit exists with exactly
 * the real math: a = (μ/ω²)^(1/3) − it hovers over one longitude. */
export const SYNCHRONOUS_ALT = Math.cbrt(EARTH.mu / (EARTH.rotationRate * EARTH.rotationRate)) - EARTH.radius;

/** mulberry32 — tiny deterministic PRNG (public-domain reference
 * implementation; seeded from the world's mission counter). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Does any legal registry satellite satisfy the mission's constraints? */
export function missionSatisfied(w: WorldState, m: MissionRecord): boolean {
  return w.objects.some((o) => {
    if (o.kind !== 'satellite' || o.func !== m.func || o.body !== m.body || o.illegal) return false;
    const el = objectElements(o);
    if (el.e >= 1) return false;
    const bodyR = o.body === 'earth' ? EARTH.radius : 1_737_400;
    const periAlt = el.rPeri - bodyR;
    const apoAlt = el.rApo - bodyR;
    if (periAlt < m.altMin || apoAlt > m.altMax || el.e > m.maxEcc) return false;
    if (m.dir !== 0 && Math.sign(el.h) !== m.dir) return false;
    return true;
  });
}

/**
 * Settle and replenish the mission board. Called after every committed
 * harvest and every world-clock advance.
 */
export function tickMissions(w: WorldState): WorldEvent[] {
  const events: WorldEvent[] = [];
  const emit = (ev: WorldEvent): void => {
    events.push(ev);
    pushLog(w, ev);
  };
  for (const m of w.missions) {
    if (m.status !== 'open') continue;
    if (m.targetId) {
      // Tug want: settled by the target LEAVING the registry. Grappled
      // and disposed → done; natural decay got it first → the want is
      // moot, recorded as expired (nature took no instructions).
      if (!w.objects.some((o) => o.id === m.targetId)) {
        const grappled = w.log.some((e) => e.type === 'deorbited' && e.id === m.targetId);
        m.status = grappled ? 'done' : 'expired';
        emit(
          grappled
            ? { type: 'missionComplete', t: w.epoch, id: m.id, title: m.title }
            : { type: 'missionExpired', t: w.epoch, id: m.id, title: m.title },
        );
        continue;
      }
    } else if (missionSatisfied(w, m)) {
      m.status = 'done';
      emit({ type: 'missionComplete', t: w.epoch, id: m.id, title: m.title });
      continue;
    }
    if (w.epoch > m.deadline) {
      m.status = 'expired';
      emit({ type: 'missionExpired', t: w.epoch, id: m.id, title: m.title });
    }
  }
  for (let guard = 0; guard < 8 && w.missions.filter((m) => m.status === 'open').length < MAX_OPEN_MISSIONS; guard++) {
    const m = generateMission(w);
    if (!m) break;
    w.missions.push(m);
  }
  return events;
}

const day = 86_400;

/** One new want, from what the program lacks. Null when the world is,
 * for the moment, content. */
function generateMission(w: WorldState): MissionRecord | null {
  const rnd = mulberry32(0x9e3779b9 ^ w.missionSeq);
  const seq = w.missionSeq++;
  const id = `M-${seq + 1}`;
  const open = w.missions.filter((m) => m.status === 'open');
  const deadline = (days: number) => w.epoch + Math.round(days + rnd() * days * 0.5) * day;

  const relaysUp = w.objects.filter((o) => o.func === 'relay' && o.body === 'earth').length;
  const wantsRelay = relaysUp < 3 && !open.some((m) => m.func === 'relay' && m.body === 'earth');
  if (wantsRelay) {
    // Alternate the two relay regimes: a MEO ring node (the 6-sat
    // continuous-coverage altitude from the street-of-coverage math)
    // and the synchronous hover slot.
    if (seq % 2 === 0) {
      const h = Math.ceil(constellationAltitude(6, EARTH.radius) / 100_000) * 100_000;
      return {
        id,
        title: `Relay node: ring altitude (≥ ${Math.round(h / 1000)} km, 6-sat coverage geometry)`,
        func: 'relay',
        body: 'earth',
        altMin: h,
        altMax: 45_000_000,
        dir: 0,
        maxEcc: 0.1,
        deadline: deadline(45),
        status: 'open',
      };
    }
    return {
      id,
      title: 'Relay: synchronous slot (hovers over one longitude)',
      func: 'relay',
      body: 'earth',
      altMin: SYNCHRONOUS_ALT - 300_000,
      altMax: SYNCHRONOUS_ALT + 300_000,
      dir: 1,
      maxEcc: 0.02,
      deadline: deadline(60),
      status: 'open',
    };
  }

  const unmapped = 1 - revealedFraction(w);
  const priorSurvey = w.missions.some((m) => m.func === 'survey');
  if (unmapped > 0.25 && !open.some((m) => m.func === 'survey')) {
    return {
      id,
      title: priorSurvey
        ? 'Survey: retrograde mapping orbit (the SSO demand direction — west corridor)'
        : 'Survey: first mapping orbit (any direction)',
      func: 'survey',
      body: 'earth',
      altMin: 250_000, // above the fast-decay floor
      altMax: SURVEY_CEILING,
      dir: priorSurvey ? -1 : 0,
      maxEcc: 0.1,
      deadline: deadline(60),
      status: 'open',
    };
  }

  const debris = w.objects
    .filter((o) => o.kind === 'debris' && o.body === 'earth')
    .sort((a, b) => (a.born ?? a.t0) - (b.born ?? b.t0));
  if (debris.length >= 3 && !open.some((m) => m.targetId)) {
    const target = debris[0]!;
    return {
      id,
      title: `Tug: deorbit ${target.name} (${target.id})`,
      func: 'tug',
      body: 'earth',
      altMin: 0,
      altMax: Infinity,
      dir: 0,
      maxEcc: 1,
      deadline: deadline(90),
      targetId: target.id,
      status: 'open',
    };
  }

  const done = w.missions.filter((m) => m.status === 'done').length;
  if (done >= 2 && !open.some((m) => m.body === 'moon')) {
    // The forcing function, sequenced last: far-side lunar operations
    // are dark without a relay the network can chain through.
    return {
      id,
      title: 'Luna relay: lunar orbit (far-side operations need it)',
      func: 'relay',
      body: 'moon',
      altMin: 500_000,
      altMax: 20_000_000,
      dir: 0,
      maxEcc: 0.5,
      deadline: deadline(120),
      status: 'open',
    };
  }
  return null;
}
