# Handoff notes for the next working session

Written 2026-07-23 at the end of the WORLDBUILDING pass (after merging
the parallel-session Heavy Lifter fix). Read this before touching code;
it is the condensed context that isn't obvious from the source.

## The worldbuilding pass (this session) — what landed

Read docs/WORLD.md first — it is the model document (session gate,
planar mapping table, governing-rule table, flagged simplifications).

1. **Heavy Lifter branch merged** (claude/wonderful-hellman-52e908):
   8 fins + 8 m Centaur + two autopilot branches (burn spent-ignition
   stages to depletion on local horizontal; circularize holds local
   horizontal when |fpa| > 25°). Golden fixtures regenerated on that
   branch, all byte-stable since.
2. **World state model** (`src/world/`): versioned save
   (`space-sim.world`, v1, corrupt→.bak, future-version refuses),
   registry of state vectors at a world epoch propagated analytically
   ON DEMAND only, orbit-averaged drag decay (energy/momentum
   formulation, pinned against Δa = −2πBρa²) as the GC, station-keeping
   from residual propellant. THE GATE: only `commit.ts` (committed
   harvest) and the Program view's clock advance ever write; the Sim
   never reads world state.
3. **Sites** (`physics/sites.ts`): Cape (east corridor), Cape Runway,
   Wideawake Field (Ascension analogue, discoverable), West Range
   strip+pad (Vandenberg analogue, west corridor, discoverable;
   landing the strip activates both). Pad wear scales with liftoff
   thrust, runway wear with touchdown roughness. Corridor violations
   detected in flight; committed ones mark deployments `illegal`.
4. **Network** (`world/network.ts`): ONE ground station at the Cape
   forever (the central balance decision), 5° elevation mask, body
   occlusion (the Moon blocks its far side — tested), BFS relay
   chains. Flight: manual commands lock while unlinked; onboard
   programs continue (RemoteTech flight computer); aircraft in
   atmosphere exempt (crew stand-in). Street-of-coverage math for the
   planner.
5. **Satellites**: three function modules (relay 150 kg / survey
   250 kg / tug 300 kg, all sourced/flagged), `Compiled.funcModules` +
   `activeFunc()`. Tug flights: 'v' cycles targets, closest-approach
   readout (`world/rendezvous.ts`, exact conics + ternary refine),
   capture 250 m / 5 m/s (flagged abstraction), registry settled at
   harvest only.
6. **Terrain reveal**: 1440 surface bins; survey reveals only while
   LINKED (one station ⇒ ~10% Cape arc; 3 relays ⇒ global — both
   pinned); committed overflight below 10 km maps its track; revealed
   sites become discovered.
7. **Debris**: sepStates recorded always, harvested to debris when the
   orbit persists (perigee > 90 km floor); registry objects render in
   flight; congestion by 100 km band.
8. **Air launch**: pylon carriage HARD ceiling 26 t × 1.6 m
   (LauncherOne/Pegasus) as a compile BLOCKER; `payloadClass` toggle
   releases plane-class payloads; recovery is a logged event.
9. **Missions** (`world/missions.ts`): deterministic wants from what
   the program lacks (relay ring/sync slot → survey any-then-retrograde
   → tug naming oldest junk → Luna relay after 2 done). No economy.
10. **Program view** (`ui/tracking.ts`): map (reveal, sites, coverage
    halo, registry, Moon), objects/age table, congestion, mission
    board, log, clock advance. Constellation planner in the VAB stats
    (relay module aboard). Launch dialog: session-model choice, site
    picker with wear, corridor feasibility vs open missions.

## Hard invariants (unchanged, plus one new)

All of the previous list (sourced physics, g₀ only for Isp, analytic
coasts, patched conics, planar 3-DOF, zero runtime deps, no audio,
terrain is paint, determinism, legible surface, golden discipline) AND:

- **The session gate.** Test flights write NOTHING to the world. If a
  feature lets a test flight dirty the registry/sites/terrain/clock,
  it is wrong. World writes live in `world/commit.ts` + the Program
  view's advance, nowhere else.
- No `Math.random`/`Date.now` in `src/world` either (mission PRNG is
  mulberry32 seeded from `missionSeq`).

## Traps and notes

- Canvas 2D arcs: angles run clockwise (y down). The tracking map draws
  surface arcs with `-angle`; get the ccw flag wrong and an arc paints
  the long way around (bit me once — coverage halo).
- `SpaceObject.t0` MOVES when decay rebuilds a state vector; `born` is
  the stable age anchor.
- The phantom-input corruption (browser automation synthesizing keys)
  showed up again this session under the in-app browser — launched a
  flight on its own. Still automation-only, never real input.
- The user supplied CC0-only asset sources (Kenney/Quaternius/
  ambientCG/Poly Haven) for a future visual pass — see the memory note;
  NO assets are in the repo yet and an asset pipeline (GLTF loader)
  would be new infrastructure against the tiny-deps rule. Scope it
  deliberately if picked up.

## Loose ends / next backlog

- **Moon transfer planner UX + PEG guidance** — still the top flight
  backlog (unchanged from last session).
- Program-view polish: no per-object focus/zoom-to, mission rows don't
  link to the planner, log is capped text.
- Live relay vessels count for comms, but a satellite deployed and NOT
  yet committed doesn't relay for OTHER later flights until harvest —
  correct by the gate, worth a UI hint.
- Tug re-flight: registry tugs are inert after their launch flight
  (documented simplification). A "reactivate tug" mechanic would need
  persisted vehicles — deliberate scope decision required.
- Survey store-and-forward (buffering when unlinked) rejected for now;
  revisit only if the relay coupling feels punitive in play.
- Deterministic rated burn time: skipped per spec option (no honest
  sources for most of the roster). Revisit only with published qual
  data in hand.
- Per-fluid pools per section (SSTO spaceplane), wave drag, vortex
  lift, Silver Dart CG pumping, jet endurance vs altitude in builder:
  all unchanged from the plane pass.
- Mission board could demand payload MASS/volume (spec mentions it);
  current wants are function+orbit+deadline only.

## Quick map of the new module

```
src/world/
  world.ts       state, save v1, registry propagation, decay/advance,
                 terrain bins, sites state/wear, congestion, missions types
  decay.ts       orbit-averaged drag (Vallado §9.6 / King-Hele), reentry floor
  network.ts     stations, elevation mask, occlusion, relay BFS, coverage math
  rendezvous.ts  closest approach on exact conics; capture constants
  missions.ts    deterministic demand model (mulberry32)
  commit.ts      THE write path: harvest, wear, activation, reveal, missions
src/ui/tracking.ts  the Program view
```

`npm test` → 144 tests / 18 files. Golden regen ritual unchanged.
