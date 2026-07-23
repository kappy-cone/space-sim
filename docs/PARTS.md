# Parts roster — non-domination table

Governing rule: every part must have a design condition under which it is
the correct choice. Anything without an answer gets removed. The schema
half of this contract is enforced by `src/physics/roster.test.ts` (every
part cited, propulsion typed, physical fields self-consistent).

**Per-class rule (since the plane class):** every part must be
non-dominated within EVERY vehicle class it is legal in. A part legal in
both classes needs a winning condition in both, or it gets restricted to
one — "it wins on a plane" is not a pass for the rocket bin, and vice
versa. The Class column says where a part is legal; ✈-only parts exist
because nothing in the rocket bin needed them and nothing about them
wins on a rocket.

## Propellants

| Fluid | Wins when | Loses because |
|---|---|---|
| Kerolox (1023 kg/m³) | First stages: dense ⇒ small/light/low-drag tanks, big SL engines exist | Mid Isp; LOX side boils slowly (0.3 %/day) |
| Hydrolox (361 kg/m³) | Upper stages where Isp (421–466 s) beats the 3× tank volume/dry-mass penalty | Boiloff 2 %/day kills multi-day missions; huge draggy tanks down low |
| Methalox (833 kg/m³) | Medium-duration missions: near-kerolox density with better Isp, boiloff 0.5 %/day between the two | Beaten by kerolox on density, by hydrolox on Isp |
| Hypergolic (1159 kg/m³, storable) | Any restart-critical or weeks-long duty: zero boiloff, pressure-fed engines light unsettled, forever | Lowest Isp (316 s); low thrust |
| Solid (1770 kg/m³) | Liftoff thrust by the meganewton, storable, cheap structure (casing is the tank) | No throttle/shutdown/restart — commitment; Isp 242–268 s |

## Engines

| Part | Wins when | Key numbers (sourced in parts.ts) |
|---|---|---|
| Merlin 1D | Clustered kerolox first stages needing deep throttle + relights (landing) | 845 kN SL, 282/311 s, 470 kg, 40–100 %, 3 lights |
| Merlin Vacuum | Kerolox upper stages: cheap, throttleable, 3 lights | 981 kN, 348 s, sep. limit 13 kPa |
| RD-180 | Single-stick kerolox cores: best kerolox Isp (311 SL), ±8° gimbal, no cluster mount mass | 3.83 MN SL, 311/338 s — but 1 light, T/W 71 |
| Rutherford | Small landers/stages: deepest throttle (20 %, est.), 5 spark lights | 24.9 kN, 35 kg |
| Raptor 2 | Methalox: high thrust AND high T/W with unlimited spark relights | 2.26 MN SL, 327/347 s, min 50 % |
| RS-25 | Hydrolox lifting from sea level (only hydrolox engine that can) | 1.86 MN SL, 366/452 s, ±10.5°, ground-lit only |
| J-2 | Heavy hydrolox upper stages: 10× RL10 thrust | 1.03 MN, 421 s, 2 lights (ullage needed), fails below ~2 km |
| RL10B-2 | Efficiency-critical hydrolox uppers: best Isp in the game once the nozzle extends | 110 kN, 435→465.5 s (deploy state), 3 lights |
| AJ10-190 | THE ullage answer: pressure-fed, lights unsettled, ∞ restarts, storable | 26.7 kN, 316 s — that Isp is the price |
| GEM-40 | Strap-on liftoff thrust per dollar of dry mass; parallel staging | 500 kN avg, regressive grain, 1 light, no TVC |
| RSRM | Meganewton-class stage-0: the max-q thrust bucket is grain-shaped | 10.7 MN avg, ±8° TVC, curve from NASA plots |
| TX-280 ullage motor | Settling without spending RCS budget; one guaranteed settle window | 15.1 kN × 3.9 s solid |

## Everything else

| Part | Wins when |
|---|---|
| Tanks (fluid × 1.2/2.4/3.7 m, length parametric) | Length is a build parameter — variants by length were cut per the rule |
| Decouplers 1.2/2.4/3.7 | Serial staging at each diameter |
| Radial pylon | Strap-on boosters: parallel burn, separate jettison |
| Radial pylon + duct | Asparagus/TSTO crossfeed: core drains the strap-on first, stages away full |
| Release pylon (✈ carrier) | Air launch: separation SPAWNS the payload as a live second vessel (control follows it; the hooks stay with the carrier) |
| Adapters 2.4→1.2, 3.7→2.4 | Mixed-diameter stacks (hydrolox uppers are fatter per kg — adapters are how you afford them) |
| Nose cones | Cd 0.25 vs 0.7 blunt face — pays its mass back in drag on any slender stack |
| Fairings 2.4/3.7 | Wide/bumpy payloads: encloses them from the drag model (upgraded so this is physics, not decoration); jettison mass when spent |
| Fins S/M/L | Passive stability at q, zero ongoing cost |
| Grid fin | Active control that scales WITH q — strongest control at max-q, useless in vacuum |
| RCS quad | Torque anywhere + the second job: ullage settling. Spends its 40 kg budget |
| CMG | Free torque in vacuum coasts — but 258 N·m only, and it saturates (4,880 N·m·s) |
| Legs S/L | Footprint vs mass against the tip-over adjudication |
| Chutes (main/drogue) | Atmospheric recovery: drogue survives 12 kPa, main needs < 2.5 kPa |
| Probe/Capsule/Station | Payloads (player cargo) with built-in RCS classes |

## Plane class (✈)

The class ships with the 20× headline: a turbofan's fuel-only Isp
(6,605 s) vs a Merlin's 311 s. Jets carry no oxidizer — the atmosphere
is the oxidizer tank — which is the entire reason the class exists. The
regime bars in the builder render this table directly: two parts whose
bars don't overlap are both worth carrying.

### Air-breathing engines (three engines, three Mach bands)

| Part | Class | Wins when | Loses because | Key numbers (sourced in parts.ts) |
|---|---|---|---|---|
| CFM56 Turbofan | ✈ | Subsonic anything: Isp 6,605 s, 120 kN static | Dead ≥ M0.95 and above ~12.6 km (ρ floor) | EASA TCDS; cruise point pinned by test |
| J79 Turbojet (A/B) | ✈ | M1–2.2: only engine alive there; ram thrust rises to M2 | 1,832 s Isp — 3.6× the turbofan's burn for the same impulse | GE/USAF J79-17, max afterburner |
| RJ43 Ramjet | ✈ | M2–4.3, to 30 km: nothing else operates there; no turbomachinery (300 kg) | **Zero static thrust — needs a boost past M1.8 to light**; 1,333 s | Marquardt Bomarc/X-7 (estimates flagged) |

Why no rocket column: jets are class-restricted to planes not because a
rocket couldn't mount one, but because a vertical-launch stack spends its
seconds getting OUT of the envelope a jet needs — by the time q is
survivable the density floor has passed. (Mixed propulsion on a PLANE is
explicitly allowed — jets to altitude + rocket relight is the spaceplane
path, and nothing blocks it.)

### Lifting surfaces (three wings + tail, three regimes)

| Part | Class | Wins when | Loses because | Analogue |
|---|---|---|---|---|
| Sailplane Wing | ✈ | Slow/efficient: AR 16.1, e 0.85 — least induced drag per lift in the game | Tears above 4 kPa q / M0.5 — it is structurally a sailplane wing | ASK-21 |
| Transport Swept Wing | ✈ | The workhorse band to M0.9 / 19 kPa; carries real tonnage | Pays 10.8 t; induced drag beats the sailplane below ~120 kt | 737-800 |
| Delta Wing (wet) | ✈ | Supersonic to M2.2 / 40 kPa, PLUS 75 m³ of fuel inside the structure, PLUS elevons (no tail needed) | AR 1.83: worst induced drag at low speed; clMax 1.1 (no vortex lift modeled — flagged); approach speeds are brutal | Concorde |
| Tailplane + Elevator | ✈ | Trim authority for any tailed layout (30 % elevator, τ = 0.66) | Dead mass on a delta (elevons already trim) | 737 stabilizer |

Fins vs wings across classes: fins stay rocket-legal (passive caliber
stability at near-zero cost); a WING on a rocket is strictly worse than
fins for stability (mass, drag) and lift is useless on a gravity-turn
ascent — wings are ✈-only. Grid fin stays rocket-only: its q-scaled
control niche on a plane is occupied by the elevator, which is free.

### Landing gear

| Part | Class | Wins when | Loses because |
|---|---|---|---|
| Fixed Gear | ✈ | 60 kg. Slow airframes where 0.15 m² of permanent CdA costs less than 2.6 t of mechanism | The drag never goes away; 8 kPa limit |
| Retractable Gear | ✈ | Anything fast: clean when up, 12 kPa gear-down placard, brakes | 2.7 t — the price of clean |

Legs vs gear: legs stay rocket-legal (vertical touchdown adjudication);
gear is ✈-only (rolling touchdown). Neither dominates the other because
they answer different landing modes.

### Existing parts reviewed against the plane class

Tanks/decouplers/adapters/nose cones: legal in both classes, same
winning condition (volume, staging, drag) — no laundering. Chutes: legal
in both (a plane may recover by canopy). RCS/CMG: legal in both; on a
plane they lose to the elevator whenever q > ~1 kPa and win in the
thin-air corner — same regime logic as rockets. Solids: legal on planes
only as boost motors (the ramjet's light-off problem is real); they keep
their rocket winning condition.

## Control authority, by regime (all five non-dominated)

gimbal — free, needs thrust · active fins — free, needs q ·
elevator (✈) — free, needs q, the plane's primary ·
CMG — free anywhere, weak, saturates · RCS — works anywhere, spends propellant (and settles tanks).

## Mechanics that keep this table honest

- Tank dry mass scales with **volume** (35 kg/m³), or hydrogen would be free.
- **Boiloff** (per-fluid scalar), or hypergolic would not exist.
- **Ullage + ignition budgets**: restarts are performed, not tooltip numbers.
- **Flow separation destroys** vacuum nozzles at low altitude: staging is physics.
- **Cluster mount mass** (estimate anchored to S-IC/octaweb): N small engines no longer strictly dominate one big one — RD-180 vs 4× Merlin is a real choice.
- **Solid commitment**: once lit, the grain decides.
