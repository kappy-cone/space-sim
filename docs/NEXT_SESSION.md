# Handoff notes for the next working session

Written 2026-07-23 at the end of the landing/realism pass. Read this before
touching code; it is the condensed context that isn't obvious from the
source.

## Hard invariants (violating any of these is the main failure mode)

- **Real, sourced physics.** Every constant carries a citation comment next
  to it. Derived or estimated values are explicitly flagged as such. No
  invented numbers presented as data.
- **g₀ = 9.80665 is for Isp↔ṁ conversion only.** Local gravity is always
  μ/r². This is the most common rocket-sim bug; the tests pin it.
- **Coasts are never integrated.** Vacuum + engines-off ⇒ universal-variable
  Kepler (`kepler.ts`). A resting vehicle is never integrated either — it is
  pinned to the rotating surface (`Sim.pinToSurface`). Only powered or
  in-atmosphere flight goes through RK4.
- **Physics stays planar 3-DOF** [x, y, θ, vx, vy, ω]. The user explicitly
  froze 6-DOF out. The builder/flight views are 3D; the sim is not.
- **Zero runtime dependencies.** Vite/Vitest/TypeScript are dev-only. If a
  dependency does something achievable in ~50 lines, write the lines. If
  something needs a heavy library, STOP and ask the user first.
- **No audio.** It was built and removed at the user's request. Do not
  re-add.
- **Terrain is paint.** The landing brief froze terrain systems: collision
  is the smooth sphere + flat pad. The landmass coloring in
  `mesh.ts/terrainColor` is visual only.
- **Determinism.** No `Date.now()`/`Math.random()` in physics (`src/physics`,
  `src/craft`). Rendering may use them (plume flicker, ring pulse). The
  determinism test will catch violations.
- **The surface is legible.** Every number a player needs is on screen; the
  builder warns before launch. Failures name the limit exceeded and by how
  much ("vertical speed 11.4 m/s, limit 6.0"), never just "crashed".

## Architecture map

```
src/physics/    pure f64 physics, no DOM
  bodies.ts       data-driven celestial bodies (Earth + Moon row); Laplace SOI
  constants.ts    sourced constants
  atmosphere.ts   USSA76 density/pressure/temperature, speed of sound, Cd(Mach)
  vec2.ts         2D vector helpers
  integrator.ts   RK4 over [r, v, θ, ω, m]
  kepler.ts       universal-variable propagation + osculating elements
  massmodel.ts    CoM/inertia/CoP (Barrowman) from part layout; legs/chutes info
  vehicle.ts      stage aggregates (thrust, ṁ, Δv, TWR)
  sim.ts          the three-regime flight sim (integrated / rails / surface)
  autopilot.ts    gravity-turn ascent + circularization (test pilot + default)
  landing.ts      suicide-burn landing autopilot (self-tests the predictor)
  parts.ts        real engine roster (sourced) + tank line
src/craft/      part catalog → craft tree → compiled vehicle
  catalog.ts      part defs incl. geometry, fins/legs/chutes
  craft.ts        tree, placements, splice-delete, starters, referenceCraft
  compile.ts      craft → Vehicle + VehicleGeometry + warnings + stability
src/gl/         hand-rolled WebGL2 (float64 camera-relative — do not regress
                this; float32 transforms visibly wobble at planet scale)
src/ui/         vab.ts (builder), flight3d.ts (flight), format.ts
```

`npm run dev` (port 5173), `npm test` (46 tests). `window.__vab` is a debug
hook to the live VAB instance.

## localStorage keys

`space-sim.craft` (current craft), `space-sim.craft.bak` (auto-backup when a
save shrinks), `space-sim.craft.undo` (persisted undo tail),
`space-sim.hangar` (named saves).

## Not implemented yet (the backlog, roughly in order)

1. **Patched-conic SOI transitions** — the moon exists in `bodies.ts` with
   real ephemeris and is rendered in the sky, but gravity is still
   single-body. Plan (user-specified): inside a body's SOI only that body's
   gravity applies; crossing the boundary re-references the state vector to
   the new primary and produces a new conic. Never n-body. Scaffolding:
   `laplaceSoi`, `soiContains`, `CelestialBody.parent/orbit`. Sim needs: SOI
   crossing detection during rails propagation (solve for boundary crossing
   time), state re-reference, `Sim.body` becoming mutable, HUD/map showing
   the active reference body, moon-relative orbit line. The moon is coplanar
   by design so 3-DOF holds.
2. **Moon landing support** — no atmosphere ⇒ pure suicide-burn; radar
   altitude & touchdown adjudication already body-generic. Needs body-aware
   pad/terrain visuals (grey terrainColor variant) and the flight view's
   hardcoded Earth assumptions audited (`toWorld` pad math is generic;
   check sky color, shells, terrain guarded by `body.atmosphere`).
3. **Landing autopilot horizontal-speed nulling / boostback** — current
   auto-land only manages vertical speed; a translated descent can fail the
   h-speed limit. Fine for drop tests, insufficient for booster return.
4. **Chutes/legs in the staging sequence** — currently manual (P/G keys).
   KSP-style: deployables as staging entries.
5. **Radial part re-parenting** — stack parts can be picked up and moved;
   radial parts only slide on their current parent.
6. **Golden trajectory tests** — record full ascent/landing state series,
   assert within tolerance, regenerate deliberately (user's footnote).
7. **Engine realism extras** — per-engine min-throttle (Merlin ~40%),
   relight limits, ullage. Estimates must be flagged.
8. **OpenRocket CoP cross-check** — build an equivalent vehicle in
   OpenRocket and compare static margins (external validation, user
   suggested).
9. **Nicer Earth** — clouds, night side, specular ocean. Visual only.

## Known bugs / rough edges to hunt

- **Ascent autopilot circularization overshoots Ap** when Δv margin is big
  (finishes e.g. 544×258 km for a 250 km target). Cut the burn smarter
  (bisect throttle near Pe target, or pitch slightly radial).
- **HUD TWR uses vacuum thrust** (flight3d `updateHud`) — slightly wrong at
  sea level; use `stageThrustAtPressure`.
- **Spool tail shows "→ 1%" throttle** briefly after MECO; cosmetic.
- **Redo stack is cleared by pickup-cancel** (`finishPickup` → `undo()`
  pushes to redo, but a subsequent action clears it) — audit undo/redo
  around drag flows.
- **Staging reorder UI** allows physically silly orders (by design — the
  verdict shows consequences) but the labels don't warn.
- **Landing panel flicker** possible near vSpeed ≈ 0 (display condition
  `vSpeed > 0`); consider hysteresis.
- **Leg visual vs physics**: splayed legs are visual; footprint comes from
  `compile.ts` (50° splay assumption). Fine, but keep them consistent if
  either changes.
- **Impact predictor** ignores lift/attitude (point-mass + chutes); document
  on screen if it misleads during high-AoA descents.
- **Phantom-input corruption** was seen ONLY under remote browser
  automation (crafts resetting, spurious stagings) — never through real
  input. Mitigations: `.bak` key, persisted undo, console warnings on
  destructive ops. If a real user reports it, take it seriously; otherwise
  don't chase ghosts.
- The **stability test rocket needs 8 large fins** because full-load CoM
  sits low (settled propellant). That is real physics, not a tuning bug —
  see compile.test.ts comments before "fixing" it.

## Tuning knobs (all in one place for calibration work)

`sim.ts`: PD gains KP=0.5/KD=1.4, GIMBAL_MAX 5°, SPOOL_TAU 0.4 s,
COAST_SLEW_RATE 5°/s, TOUCHDOWN_LIMITS. `landing.ts`: FINAL_DESCENT_SPEED
2 m/s, burn margin 1.05, LEG_DEPLOY_ALT 2 km. `atmosphere.ts`:
CD_MACH_TABLE. `compile.ts`: MAX_Q_* structural limits, LEO_BUDGET.
`autopilot.ts`: pitch program exponent 0.4, ref speed 7800 m/s.
