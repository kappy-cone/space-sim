# space-sim

A small rocket-building sim: assemble a rocket in a 3D VAB, launch it, find
out whether it made orbit — and whether it stayed pointing the right way.
Real physics under the hood, all the numbers on screen.

## Run

```bash
npm run dev     # → http://localhost:5173
npm test        # physics + pipeline validation suite
```

Zero runtime dependencies; Vite + Vitest + TypeScript only (all native
arm64). Rendering is hand-rolled WebGL2 with a float64 camera-relative
pipeline (no float32 wobble at planetary distances).

## Physics (`src/physics/`)

**3-DOF planar simulation**: state [x, y, θ, vx, vy, ω] in the orbital
plane of a **named reference body** ([bodies.ts](src/physics/bodies.ts) — a
data-driven table with μ, radius, SOI, parent; one row today, moon-ready
via patched conics later). Every constant carries its source.

- **Constants/atmosphere**: IERS μ⊕, WGS-84 radius/rotation, g₀ (CGPM,
  Isp only — never local gravity), USSA76 density (Vallado Table 8-4) and
  barometric pressure layers.
- **Engines** ([parts.ts](src/physics/parts.ts)): real Merlin 1D/MVac,
  RS-25, Raptor 2, RL10B-2, Rutherford; ṁ = F_vac/(g₀·Isp_vac); thrust
  linear in ambient pressure; first-order spool-up (τ = 0.4 s).
- **Attitude dynamics** ([sim.ts](src/physics/sim.ts)): thrust along the
  body axis; ±5° gimbal driven by a PD controller; aerodynamic normal
  force at the Barrowman CoP (restoring when CoP is aft of CoM, flipping
  when it isn't) + pitch damping; small pod RCS torque; on-rails coasts
  slew attitude instead of integrating.
- **Mass model** ([massmodel.ts](src/physics/massmodel.ts)): CoM, pitch
  inertia, and CoP from part positions; propellant settles and drains so
  stability changes mid-flight. CoP via the Barrowman method (NASA
  TIR-33): nose/transition/fin-set component C_Nα.
- **Structure**: per-part dynamic-pressure limits — fins and nose cones
  tear off, hull failure destroys the vehicle, with events naming what
  broke and at what q.
- **Trajectory**: fixed-step RK4 powered/atmospheric; universal-variable
  Kepler for every coast (never integrated — exact at any warp).

### Validation (33 tests)

Tsiolkovsky to 1e-9 · energy/momentum over 1000 Kepler orbits · Hohmann vs
closed form · terminal velocity · RK4 drift < 1e-10/orbit · Kepler round
trips · cylinder inertia closed form · CoM shift from settling · Barrowman
component sanity · finned stick weathervanes, finless stick tumbles · the
reference craft compiles stable, clears the LEO budget, and reaches orbit
through the full craft → compile → 3-DOF sim → autopilot pipeline.

## The game

- **VAB** ([vab.ts](src/ui/vab.ts)): stack/radial attachment nodes, radial
  symmetry ×2–8, engine clusters, fins, drag-reposition radial parts on
  the surface, reorderable staging, click-to-inspect part stats, undo/redo
  (buttons + ⌘Z, persisted across reloads), and live panels: per-stage Δv
  / TWR / burn time, total Δv vs the ~9.4 km/s LEO budget, **CoM/CoP
  markers on the vehicle with the static margin in calibers**, and
  warnings for asymmetric builds the planar sim can't represent. Deleting
  a mid-stack part splices the stack; only radial subtrees go together.
- **Flight** ([flight3d.ts](src/ui/flight3d.ts)): fully 3D, interactive
  orbit camera from pad close-up to whole-orbit view, rendering **the
  actual craft you built** at the simulated attitude — plumes that widen
  as ambient pressure drops, parts that visibly disappear when shed or
  staged, the live conic and trail, and an event feed. Autopilot
  (gravity-turn + apoapsis-centered circularization) or manual: throttle
  slider/keys, pitch arrows, space to stage. HUD adds q, AoA, live
  stability margin, and gimbal deflection.

The default craft is a known-good reference rocket (also the test
vehicle); "New craft" starts blank, "Reference rocket" restores it.

## Layout

```
src/physics/   pure double-precision physics, no DOM (bodies → sim)
src/craft/     part catalog, craft tree, compile → vehicle + geometry + aero
src/gl/        minimal WebGL2: f64 mat4, procedural meshes, renderer, picking
src/ui/        VAB editor, 3D flight view, formatting
```
