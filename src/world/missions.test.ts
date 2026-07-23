// The demand model: deterministic generation, constraint adjudication,
// corridor-illegal exclusion, tug settlement through the log, deadline
// lapse, and the Moon gate.

import { describe, expect, it } from 'vitest';
import { EARTH } from '../physics/bodies';
import { MAX_OPEN_MISSIONS, SYNCHRONOUS_ALT, missionSatisfied, tickMissions } from './missions';
import { SpaceObject, WorldState, advanceWorld, emptyWorld, pushLog } from './world';

function sat(
  id: string,
  func: 'relay' | 'survey' | 'tug',
  hPeri: number,
  hApo = hPeri,
  dir: 1 | -1 = 1,
  extra: Partial<SpaceObject> = {},
): SpaceObject {
  const rp = EARTH.radius + hPeri;
  const ra = EARTH.radius + hApo;
  const a = (rp + ra) / 2;
  const vp = Math.sqrt(EARTH.mu * (2 / rp - 1 / a));
  return {
    id,
    name: id,
    kind: 'satellite',
    func,
    body: 'earth',
    r: [rp, 0],
    v: [0, dir * vp],
    t0: 0,
    mass: 500,
    skProp: 20,
    cdA: 3,
    launch: 1,
    born: 0,
    ...extra,
  };
}

describe('mission generation', () => {
  it('is deterministic and fills the board', () => {
    const a = emptyWorld();
    const b = emptyWorld();
    tickMissions(a);
    tickMissions(b);
    expect(a.missions).toEqual(b.missions);
    // A fresh board opens what the program lacks (coverage + mapping) —
    // the generator does not pad to the cap for its own sake.
    const open = a.missions.filter((m) => m.status === 'open').length;
    expect(open).toBeGreaterThanOrEqual(2);
    expect(open).toBeLessThanOrEqual(MAX_OPEN_MISSIONS);
    // A fresh program is asked for coverage and mapping first.
    expect(a.missions.some((m) => m.func === 'relay')).toBe(true);
    const survey = a.missions.find((m) => m.func === 'survey');
    expect(survey).toBeDefined();
    expect(survey!.dir).toBe(0); // the FIRST survey want takes any direction
  });

  it('later survey wants demand the retrograde (SSO-analogue) direction', () => {
    const w = emptyWorld();
    tickMissions(w);
    const first = w.missions.find((m) => m.func === 'survey')!;
    first.status = 'expired'; // lapse it; the replacement knows a survey existed
    tickMissions(w);
    const second = w.missions.filter((m) => m.func === 'survey' && m.status === 'open').pop();
    expect(second).toBeDefined();
    expect(second!.dir).toBe(-1);
  });
});

describe('mission adjudication', () => {
  it('the synchronous slot wants the band, the direction, and legality', () => {
    const w = emptyWorld();
    tickMissions(w);
    // Force a synchronous mission onto the board for the check.
    const m = {
      id: 'M-X',
      title: 'sync',
      func: 'relay' as const,
      body: 'earth',
      altMin: SYNCHRONOUS_ALT - 300_000,
      altMax: SYNCHRONOUS_ALT + 300_000,
      dir: 1 as const,
      maxEcc: 0.02,
      deadline: w.epoch + 30 * 86_400,
      status: 'open' as const,
    };
    expect(missionSatisfied(w, m)).toBe(false);
    w.objects.push(sat('R-low', 'relay', 500_000)); // wrong band
    expect(missionSatisfied(w, m)).toBe(false);
    w.objects.push(sat('R-retro', 'relay', SYNCHRONOUS_ALT, SYNCHRONOUS_ALT, -1)); // wrong way
    expect(missionSatisfied(w, m)).toBe(false);
    w.objects.push(sat('R-illegal', 'relay', SYNCHRONOUS_ALT, SYNCHRONOUS_ALT, 1, { illegal: true }));
    expect(missionSatisfied(w, m)).toBe(false); // corridor violators earn nothing
    w.objects.push(sat('R-good', 'relay', SYNCHRONOUS_ALT));
    expect(missionSatisfied(w, m)).toBe(true);
    w.missions.push(m);
    const events = tickMissions(w);
    expect(events.some((e) => e.type === 'missionComplete')).toBe(true);
  });

  it('deadlines lapse with the clock', () => {
    const w = emptyWorld();
    tickMissions(w);
    const horizon = Math.max(...w.missions.map((m) => m.deadline));
    advanceWorld(w, horizon + 86_400);
    const events = tickMissions(w);
    expect(events.filter((e) => e.type === 'missionExpired').length).toBeGreaterThan(0);
  });

  it('tug wants name real junk and settle through the log', () => {
    const w = emptyWorld();
    // Sated on relays+survey so the tug want can surface: three relays
    // up, terrain fully revealed.
    for (let i = 0; i < 3; i++) w.objects.push(sat(`R-${i}`, 'relay', 2_000_000));
    w.revealed = 'f'.repeat(w.revealed.length);
    for (let i = 0; i < 3; i++) {
      w.objects.push({ ...sat(`D-${i}`, 'relay', 400_000 + i * 50_000), kind: 'debris', func: undefined, skProp: 0 });
    }
    tickMissions(w);
    const tug = w.missions.find((m) => m.targetId);
    expect(tug).toBeDefined();
    expect(tug!.targetId).toBe('D-0'); // the oldest piece
    // Grappled and disposed: object gone + a 'deorbited' log entry.
    w.objects = w.objects.filter((o) => o.id !== 'D-0');
    pushLog(w, { type: 'deorbited', t: w.epoch, id: 'D-0', name: 'D-0' });
    const events = tickMissions(w);
    expect(events.some((e) => e.type === 'missionComplete')).toBe(true);
    expect(w.missions.find((m) => m.targetId === 'D-0')!.status).toBe('done');
  });

  it('the Moon want appears once the program has proven itself', () => {
    const w = emptyWorld();
    tickMissions(w);
    expect(w.missions.some((m) => m.body === 'moon')).toBe(false);
    for (const m of w.missions.slice(0, 2)) m.status = 'done';
    // Keep the board otherwise sated: relays up + terrain mapped.
    for (let i = 0; i < 3; i++) w.objects.push(sat(`R-${i}`, 'relay', 2_000_000));
    w.revealed = 'f'.repeat(w.revealed.length);
    tickMissions(w);
    expect(w.missions.some((m) => m.body === 'moon' && m.func === 'relay')).toBe(true);
  });
});
