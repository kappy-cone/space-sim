# Handoff notes for the next working session

Written 2026-07-23 at the end of the SOI/moon pass (the session after the
landing/realism pass). Read this before touching code; it is the condensed
context that isn't obvious from the source.

## Hard invariants (violating any of these is the main failure mode)

- **Real, sourced physics.** Every constant carries a citation comment next
  to it. Derived or estimated values are explicitly flagged as such. No
  invented numbers presented as data.
- **g₀ = 9.80665 is for Isp↔ṁ conversion only.** Local gravity is always
  μ/r². The tests pin it.
- **Coasts are never integrated.** Vacuum + engines-off ⇒ universal-variable
  Kepler (`kepler.ts`), now with patched-conic SOI handoffs inside
  `Sim.stepRails`. A resting vehicle is pinned to the rotating surface.
  Only powered or in-atmosphere flight goes through RK4. A stage that
  cannot light (ignition budget spent) counts as a coast.
- **Patched conics, never n-body.** Inside a body's SOI only that body's
  gravity applies. Crossings bisect to 1 ms on rails (`railsSafeDt` makes
  tunneling impossible at any step size) and re-reference the state
  vector (`Sim.reReference`). `soi.test.ts` cross-validates continuity,
  per-frame energy conservation, and the gravity assist.
- **Physics stays planar 3-DOF** [x, y, θ, vx, vy, ω]. The user froze
  6-DOF out. The moon is coplanar by design so 3-DOF holds.
- **Zero runtime dependencies.** Vite/Vitest/TypeScript are dev-only. No
  @types/node either — `src/node-builtins.d.ts` declares the few node
  builtins the tests use.
- **No audio.** Built and removed at the user's request. Do not re-add.
- **Terrain is paint.** Collision is the smooth sphere + flat pad. The
  landmass/regolith coloring and the local ground cap are visual only.
- **Determinism.** No `Date.now()`/`Math.random()` in physics (`src/physics`,
  `src/craft`). Rendering may use them (plume flicker, streaks, glow).
- **The surface is legible.** Failures name the limit exceeded and by how
  much — touchdown limits, breakup q, ignition budgets all do this.
- **Golden fixtures change only deliberately.** `golden.test.ts` pins full
  ascent/landing state series at 1e-6 relative. A deliberate physics
  change regenerates with `GOLDEN_REGEN=1 npx vitest run
  src/physics/golden.test.ts` and the fixture diff gets reviewed in the
  commit.

## Architecture map

```
src/physics/    pure f64 physics, no DOM
  bodies.ts       body table (Earth + Moon) + bodyOrbitState ephemeris,
                  childrenOf, Laplace SOI
  constants.ts    sourced constants
  atmosphere.ts   USSA76 density/pressure/temperature, Cd(Mach)
  vec2.ts         2D vector helpers
  integrator.ts   RK4 over [r, v, θ, ω, m]
  kepler.ts       universal-variable propagation + osculating elements
  massmodel.ts    CoM/inertia/CoP (Barrowman) from part layout
  vehicle.ts      stage aggregates incl. stageMinThrottle/stageIgnitionLimit
  sim.ts          three-regime sim + SOI transitions + engine limits
  autopilot.ts    gravity-turn ascent + energy-cutoff circularization
  landing.ts      suicide-burn autopilot with h-speed nulling tilt
  parts.ts        engine roster incl. minThrottle/ignitions (sourced/flagged)
src/craft/      catalog → craft tree → compiled vehicle
src/gl/         hand-rolled WebGL2 (float64 camera-relative — do not regress;
                also do not draw near-field geometry with a far-away model
                origin: that's what caused the flashing-pad bug. Local
                ground caps exist for exactly this.)
src/ui/         vab.ts (builder), flight3d.ts (flight), format.ts
```

`npm run dev` (port 5173, or PORT env), `npm test` (60 tests).
`window.__vab` and `window.__flight` are debug hooks to the live views.

## localStorage keys

`space-sim.craft` (current), `space-sim.craft.bak` (auto-backup when a save
shrinks), `space-sim.craft.undo` (persisted undo tail), `space-sim.hangar`.

## Done this session (was the backlog)

1. Patched-conic SOI transitions + cross-validation suite (`soi.test.ts`).
2. Moon landing (airless suicide burn, tested; flight view body-generic:
   per-body terrain spheres/caps, black sky, pad only on Earth,
   moon-relative orbit line incl. hyperbolic arcs, trail frame conversion,
   Ref-body HUD row, 10,000× warp).
3. Landing autopilot h-speed nulling (tilt against drift, tested at 25 m/s).
4. Deployables in the staging sequence (flight-side queue; VAB shows the
   tail; entries consumed implicitly by autopilot/manual actions).
5. Radial re-parenting (drag off the surface → pickup/ghost flow) + the
   undo/redo rollback fix (cancelled gestures no longer eat redo history).
6. Golden trajectory tests (`golden.test.ts` + fixtures).
7. Per-engine min-throttle floors and ignition budgets (+ HUD readouts,
   named ignition denial, `engines.test.ts`).
8. Bug fixes: circularization Ap overshoot (energy cutoff + spool-tail
   anticipation), HUD TWR at ambient pressure, spool-tail 1% snap,
   landing-panel hysteresis, liftoff re-pin (23 m sideways snap), stale
   ORBIT banner, flashing pad (polygonOffset + anchored ground cap),
   landing-autopilot final phase now uses thrust-at-pressure.
9. Descent feel: airflow streaks, √ρ·v³ compression glow, cap mottling.

## Not implemented yet (the new backlog, roughly in order)

1. **Moon mission UX**: a maneuver-node-style transfer planner (even just
   a "burn prograde at T-x for TLI" hint), and a moon-relative impact
   predictor readout check. Landing on the moon works but finding it is
   manual.
2. **PEG-class ascent guidance** (linear tangent): the current
   circularization is energy-cutoff prograde, which legitimately leaves
   e ≈ 0.01 on lofted profiles (documented in sim.test.ts). Powered
   explicit guidance would hit r/vr/h targets simultaneously.
3. **Crash/wreck visuals**: a crashed vehicle currently keeps rendering
   intact at its final state; landingFailed should at least tip/scatter.
4. **OpenRocket CoP cross-check** (external validation, user suggested).
5. **Nicer Earth**: clouds, night side, specular ocean. Visual only.
6. **Ullage / propellant settling for relights** (flagged estimates), if
   engine realism continues.

## Known rough edges

- **Staging reorder UI** allows physically silly orders (by design — the
  verdict shows consequences) but the labels don't warn.
- **Impact predictor** ignores lift/attitude (point-mass + chutes).
- **Deep-throttle bang-bang**: engines with floors above hover thrust
  (e.g. Rutherford on the moon) force pulsed final descents, which eat
  ignition budget. That is real physics; the moon landing tests pass
  within 2 lights, but a player hovering manually can strand themselves —
  the denial event names it.
- **The stability test rocket needs 8 large fins** — real physics (low
  full-load CoM from settled propellant), see compile.test.ts comments.
- **Phantom-input corruption** was seen ONLY under remote browser
  automation (this session: an in-app-browser scroll synthesized a page
  key that launched the rocket). Never reproduced with real input; the
  .bak key, persisted undo, and console warnings remain as mitigations.

## Tuning knobs

`sim.ts`: KP=0.5/KD=1.4, GIMBAL_MAX 5°, SPOOL_TAU 0.4 s (exported),
COAST_SLEW_RATE 5°/s, TOUCHDOWN_LIMITS. `landing.ts`: FINAL_DESCENT_SPEED
2 m/s, burn margin 1.05, LEG_DEPLOY_ALT 2 km, h-null gain 0.7/s, tilt cap
0.2 rad. `autopilot.ts`: pitch exponent 0.4, ref speed 7800 m/s, TAPER
2.5 s, ignition at tBurn/2 before apo. `atmosphere.ts`: CD_MACH_TABLE.
`compile.ts`: MAX_Q_* limits, LEO_BUDGET.
