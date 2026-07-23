// Entry point: VAB is the home screen; Launch hands the compiled vehicle
// and the craft (for rendering the real rocket) to the 3D flight view.

import { Compiled } from './craft/compile';
import { Craft } from './craft/craft';
import { Flight3D } from './ui/flight3d';
import { Vab } from './ui/vab';

const app = document.getElementById('app')!;

let current: { destroy(): void } | null = null;

function showVab(): void {
  current?.destroy();
  current = new Vab(app, showFlight);
}

function showFlight(compiled: Compiled, craft: Craft): void {
  current?.destroy();
  current = new Flight3D(app, compiled, craft, 250_000, showVab);
}

showVab();
