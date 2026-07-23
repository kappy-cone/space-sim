// Entry point: VAB is the home screen; Launch hands the compiled vehicle
// and the craft (for rendering the real rocket) to the 3D flight view.
//
// The persistent world loads once here and is threaded through both
// views. Flights READ it freely (sites, network, registry); only a
// COMMITTED flight's harvest — or an explicit world-clock advance —
// writes it back. Test flights leave no trace.

import { Compiled } from './craft/compile';
import { Craft } from './craft/craft';
import { Flight3D, LaunchContext } from './ui/flight3d';
import { Dogfight3D } from './ui/dogfight3d';
import { WorldViewer } from './ui/worldviewer';
import { Vab } from './ui/vab';
import {
  WORLD_STORAGE_KEY,
  WorldState,
  deserializeWorld,
  emptyWorld,
  serializeWorld,
} from './world/world';

const app = document.getElementById('app')!;

function loadWorld(): WorldState {
  const raw = localStorage.getItem(WORLD_STORAGE_KEY);
  if (raw !== null) {
    try {
      const w = deserializeWorld(raw);
      if (w) return w;
      // Corrupt save: stash it for recovery, start fresh (the .bak
      // pattern the craft save uses).
      localStorage.setItem(`${WORLD_STORAGE_KEY}.bak`, raw);
      console.warn('[world] corrupt save stashed at .bak — starting a fresh world');
    } catch (e) {
      // A newer save version: do NOT overwrite it.
      throw e;
    }
  }
  return emptyWorld();
}

const world = loadWorld();
const saveWorld = (): void => localStorage.setItem(WORLD_STORAGE_KEY, serializeWorld(world));

let current: { destroy(): void } | null = null;

function showVab(): void {
  current?.destroy();
  current = new Vab(app, showFlight, world, saveWorld, showDogfight, showWorld);
}

function showFlight(compiled: Compiled, craft: Craft, launch: LaunchContext): void {
  current?.destroy();
  current = new Flight3D(app, compiled, craft, 250_000, showVab, launch);
}

function showDogfight(): void {
  current?.destroy();
  current = new Dogfight3D(app, showVab, world);
}

function showWorld(): void {
  current?.destroy();
  current = new WorldViewer(app, showVab, world);
}

showVab();
