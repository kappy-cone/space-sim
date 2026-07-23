# The world: persistent state between flights

A launch is an entry in a program, not an isolated sandbox run. This
document is the map of the world layer (`src/world/`), its planar
mapping decisions, and the governing-rule table — every world element
justified by the build or flight decision it changes.

## The session model (load-bearing)

Every write to the world is gated on the flight mode chosen in the
launch dialog:

- **Test flight** — the iteration loop. Reads the world freely (sites,
  network, registry — you test against the sky you actually have) and
  writes *nothing*: no registry entries, no debris, no site wear, no
  terrain reveal, no clock movement.
- **Committed flight** — launches at the world epoch (moon phase and
  site rotation continuous across the program) and is harvested exactly
  once on exit (`world/commit.ts`): orbits become registry entries,
  spent stages become debris, landings become recoveries and site
  activations, overflown terrain reveals, the clock advances, the
  mission board settles.

The `Sim` itself never reads world state; the golden fixtures pin that
a fresh save with an empty world behaves byte-identically to the
pre-world sim.

## The planar mapping, stated once

The sim is planar 3-DOF by frozen invariant. The doc-level concepts map
honestly:

| 3D concept | Planar analogue | What was dropped |
|---|---|---|
| Site latitude → min inclination | Per-site range corridor (east/west over open water) | Latitude itself; plane-change burns |
| Polar / sun-synchronous imaging orbit | **Retrograde** orbit (real SSO *is* retrograde, i≈98°, flown from Vandenberg paying the rotation penalty — reproduced exactly as ∓ωR) | J2 precession that makes SSO sun-synchronous |
| Plane change cost | Direction flip = 2×v_orb ≈ 15.6 km/s in LEO (stated pre-launch; effectively impossible, which is honest) | Partial-plane-change economics |
| GEO | Synchronous altitude a=(μ/ω²)^⅓ − R = 35,786 km — the real number; hovers over one longitude | Longitude drift/stationkeeping boxes |
| Ground track / swath | 1-D surface-angle bins (1440 × 0.25° ≈ 27.8 km) | Cross-track swath width |

## Governing-rule table

Every world element must change a build or flight decision. The table;
anything that couldn't fill the right column was cut.

| Element | The decision it changes |
|---|---|
| **Registry + committed/test split** | Whether to fly the cheap iteration or the flight that counts — and what residual propellant to leave aboard, since it becomes station-keeping life |
| **One ground station** | Whether to buy relay coverage before anything ambitious; without it, manual control ends at the Cape's horizon and survey imagery stops at ±13° |
| **LOS control loss** | Ascent profiles and mission timing planned around network visibility; onboard programs (autopilot) become the way through dark arcs |
| **Relay module** | Wants high orbit (ring altitude ≥1,400 km for 6-sat continuous coverage, or the synchronous slot) → restartable upper stage, ignition budget, ullage for the circularization — a different rocket than a LEO hauler |
| **Survey module** | Wants a low orbit (≤900 km imaging ceiling) in the retrograde demand direction → the West Range corridor, no rotation bonus (+930 m/s swing vs prograde) → different site, different margins |
| **Tug module** | Wants the target's orbit → storables, deep throttle, many ignitions, and rendezvous propellant; the closest-approach readout is flown, not scripted |
| **Station-keeping = residual propellant** | Tank sizing on satellites: life is the propellant you didn't burn getting there (Isp 300 s class, drag Δv bought back until dry) |
| **Range corridors** | Which pad a vehicle is legal at; a retrograde mission from the Cape is refused by geometry before liftoff, not after |
| **Site wear (thrust-scaled pads, roughness-scaled runways)** | Gentler vehicles and softer touchdowns quietly extend site availability; multiple sites become worth holding |
| **Discoverable sites** | Whether to spend a launch on survey coverage or fly a 3,600–11,000 km ferry sortie; activation is a landing you must fly |
| **Terrain reveal (link-gated)** | Relay constellation before global survey coverage — one station bounds imagery to the Cape arc (pinned by test) |
| **Debris persistence + decay** | Where to stage: corridor litter with perigee above 90 km stays up and crowds bands (congestion bars); decay is the physical GC, and low disposal orbits clean themselves |
| **Air-launch carriage ceiling (26 t × 1.6 m)** | Whether a payload flies from a pad or a pylon — a hard compile blocker no engineering works around (LauncherOne/Pegasus class) |
| **Missions (declarative wants)** | What to build next: the board tracks what the program lacks; illegal (corridor-violating) deployments satisfy nothing |
| **The Moon (far-side relay)** | A relay launched on an *earlier* flight becomes a prerequisite — the mission becomes a program; occlusion falls out of the same LOS geometry (tested) |
| **Suppliers** | Nothing — by design. Zero data changed; the non-domination table expressed as fiction so the tradeoff structure is learnable as "who makes what" |
| **Constellation planner / feasibility panel** | N ↔ altitude before building; corridor-vs-mission direction before lifting off. The player never discovers a geometric impossibility in flight |

## Simplifications, flagged

- Decay uses the static USSA76/Vallado exponential atmosphere: no solar
  cycle (real decay times vary ×3–5), tumbling mean CdA, no atmosphere
  rotation (≤7% at LEO speeds).
- Survey has no onboard storage: imaging counts only while linked
  (couples survey to relays; real birds buffer and downlink).
- Tug capture inside 250 m / 5 m/s is a proximity-ops abstraction (KSP
  claw prior art; MEV-1 docked at cm/s with tooling this sim doesn't
  model). Grappled mass is a point-mass add — attitude inertia
  unchanged.
- Aircraft are exempt from the link rule (piloted — the crew stand-in;
  RemoteTech's crewed exemption).
- Signal delay dropped (needs scripting to be playable), link budgets,
  power, antenna pointing dropped with it.
- Decay-phase advance keeps argPeri and advances phase by the new mean
  motion (true phase through a decay arc is not analytically
  recoverable; nothing reads it to better than an orbit).
- Registry-side tugs are not re-flyable: a tug works during its own
  launch flight, then becomes a satellite.
- Deterministic engine burn-time ratings (Test Lite style) were
  SKIPPED, as the spec allowed: honest qualification-duration numbers
  are not published for most of the roster, and the ignition budget +
  min-throttle floors already provide the non-dominated restart axis
  without inventing data.

## Excluded (per the spec)

No economy, crew, science, power/thermal, n-body, colonies, autopilot
scripting. Where a limit matters it is a scalar (imaging ceiling,
carriage rating, elevation mask), never a subsystem.
