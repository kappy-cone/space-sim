# Handoff notes for the next working session

Written 2026-07-23 at the end of the PLANE-CLASS pass (after the parts
expansion). Read this before touching code; it is the condensed context
that isn't obvious from the source.

## The plane-class pass (this session) — what landed

1. **Previous session's five loose ends fixed first**: methalox 1.2 m
   tank; RCS torque always requires propellant (free legacy path gone);
   legs/chutes on the generic DeployDef mechanism; crossfeed-honest
   builder Δv (`phaseWalkReport` — closed-form walk of the sim's own
   drain order; asparagus provably beats plain parallel); drain-order
   arrows in the staging panel.
2. **Regression baseline** cut BEFORE any plane code: Heavy Lifter golden
   trajectory + `golden/compile.json` (every builder number for every
   starter, exact-match). Rocket fixtures stayed byte-identical through
   the whole pass — the gate is `Vehicle.planeAero` (absent on every
   rocket; the CLASS gates at compile, not the parts).
3. **Flight model** (`aero.ts`, all cited): Prandtl/Helmbold finite-wing
   slopes, stall α = Cl_max/a blending 5° to Hoerner flat plate, induced
   drag, Glauert flap effectiveness, Nelson downwash. One shared
   `planeSurfaceForces()` feeds the RK4 deriv AND the Δv accounting.
   Elevator rides the control cascade gimbal-style, authority probed
   NUMERICALLY from the same force function. **Sign trap**: the planar
   CCW AoA convention makes "nose toward sky" heading-dependent —
   incidence/elevator offsets are signed by sign(r×v). planeStability()
   gives NP + static margin in %MAC.
4. **Jets**: thrust = T_SL·(ρ/ρ₀)·f(M), ṁ = tsfc·T (fuel only), flameout
   envelope with named events + windmill relight. CFM56 (Isp 6,605 s —
   the 20× headline), J79 max-A/B (M0–2.2), RJ43 ramjet (ZERO static
   thrust, boost to M1.8 to light, M4.3). The CFM56 f(M) table is
   calibrated to the published cruise point IN THIS SIM'S atmosphere
   (which reads ~25 % thin at 11 km) and frozen behind a pinned test.
5. **Parts**: 3 wings (ASK-21 / 737-800 / wet Concorde delta with
   elevons + 75 m³ internal fuel) + tailplane, 2 gears (fixed vs
   retractable — mass vs clean), per-part maxQ/maxMach (the scalar
   heating stand-in, checked only at meaningful q). PARTS.md has the
   per-class column; roster.test pins non-overlapping wing bands.
6. **Builder**: class picker (New rocket / New plane), class-filtered
   bin, %MAC + trim-authority readout (never calibers on a plane), honest
   plane verdicts (no LEO claim off a 6,605 s Isp — jet stages show
   'air'), regime bars (Mach + altitude strips per propulsion/lifting
   part) in the bin.
7. **Runway + ground roll**: `stepRolling` — 1-D along-surface dynamics
   between the pin and free flight; kinematic rotation (3°/s, 12° clamp);
   liftoff at L + T·sinθ ≥ W with a continuous seam; runway touchdown
   mode (sink vs 14 CFR 25.473, tilt vs the RUNWAY) entering a braking
   rollout (touch-and-go works); sites.ts (pad + 4 km runway). Planes
   rest HORIZONTAL and fly manual.
8. **Starter planes**: Gull Trainer, Stratoliner, Silver Dart (Concorde
   proportions; engines in mid-ship pods because a tail stack drags the
   CG behind the wet delta's NP), Air Launcher (carrier + two-stage
   J79→ramjet dart on the release pylon — the X-7 sortie).
9. **Two persistent vessels**: release pylons spawn the payload as a live
   second Sim (compile lumps the sub-craft's EXACT wet mass into
   sepMass — conservation by construction; the released section is
   strap-on-flagged so carrier engines burn through the release).
   `[`/`]` switch; per-vessel trails/events (name-prefixed); global warp
   takes the strictest per-vessel clamp; scope-fenced to release pylons
   only (normal staging is still mass subtraction).

Flying notes from the live sortie: rotating at Vs parks you ON the
lift≈weight boundary where induced drag eats the thrust surplus — rotate
~1.25·Vs. The Gull will skip (lift off, touch, lift again) if held level
at full throttle; that's real.

## Loose ends from the plane pass (pick up next)

- **Heavy Lifter can't reach orbit under the stock AP** (pinned in the
  heavy-ascent golden; separate task/worktree may already address it).
- **Mixed jet+rocket in ONE stage can't both feed** (pools are one fluid
  per section — liquids[0] wins). Serial jet stage → rocket stage works;
  a true SSTO spaceplane wants per-fluid pools per section.
- **Silver Dart dry CG is near-neutral** (fuel burn walks the CG — the
  real Concorde pumped fuel; consider a CG readout vs fuel state or
  accept as the delta's character).
- **Sailplane wing has no starter** (nothing slow enough in the engine
  roster; it's a bin part for player builds).
- **Supersonic wave drag isn't modeled** (delta cd0 is flat; the
  machDragFactor covers the body only) and **vortex lift is absent**
  (delta clMax 1.1 flagged conservative).
- **Released vessels are always rocket-class** (a released plane would
  need a class flag on the pylon or sub-craft).
- **Jet burn-time/endurance in the builder is static-thrust only**.
- **Carrier recovery isn't scored** (landing the carrier after release
  works physically; nothing celebrates it).
- Hint bar doesn't mention `[`/`]` switching.

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

## Full moon mission (flown live, 2026-07-23)

A complete mission was flown end-to-end in the browser: 4-stage vehicle
(9×Merlin / MVac / RL10 / single-Rutherford legged lander, 17.3 km/s),
autopilot ascent, phase-angle-timed TLI, SOI handoff, mid-course trim,
stage jettison, and a two-burn autoland to a 3.7 m/s lunar touchdown
with 118 kg of propellant and one ignition to spare. The first attempt
exposed the orbital-arrival landing bug (fixed, regression-tested in
landing.test.ts — see that commit). Mission-driving learnings:
- Phasing/TLI timing was done with an injected page script; a proper
  in-game transfer planner is the top backlog item.
- Stacking parts below a clustered engine duplicates the subtree per
  cluster instance (instanceCount semantics) — 2× engines on the lander
  silently doubled everything below it in the VAB. Consider a warning.

## Parts expansion (this session)

The roster expansion landed: propellant types with real densities +
per-fluid boiloff, volumetric parametric tanks (35 kg/m³ structure),
solids with grain thrust curves, ullage/flameout with RCS-settle and
ullage motors, flow-separation destruction, extendable nozzles, radial
pylons with parallel staging and crossfeed (pools per stage), cluster
mount mass, per-stage drag with fairing enclosure, control-authority
parts (RCS quads, CMG, grid fin), plume expansion + shock diamonds, and
the shader-hole fix for near-field planet z-fighting. The non-domination
table is docs/PARTS.md; the schema validator is roster.test.ts. Starters
now span the roster (Heavy Lifter = RD-180 + GEM-40s + Centaur; Crew
Ferry = hypergolic OMS insertion; Moon Freighter = hydrolox + ullage
motors + fairing; Moon Hopper = pressure-fed lander).

Loose ends worth picking up next: builder Δv for crossfeed/parallel
phases is still the serial per-stage estimate (honest but approximate);
drain-order arrows in the builder are text-only ("strap-on · crossfeeds
the core"); legs/chutes still use their pre-existing deploy systems
rather than the generic deploy mechanism; RCS torque drain only applies
to vehicles with a budget (legacy pods free); no methalox tank at 1.2 m.

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
- **Camera vertical is world-fixed**: after flying around a body the
  local horizon renders diagonal (e.g. landed on the moon). Align the
  orbit camera's up-reference to local vertical.
- **Auto-land button label** doesn't refresh when the flag is toggled
  programmatically (debug-hook path only).
- **Trim-burn blip**: a controller that lights the engine and re-checks
  its cutoff on the next tick can burn one ignition for a 0.1 s blip —
  in-game maneuver tooling should check before lighting.
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
