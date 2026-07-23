# Parts roster — non-domination table

Governing rule: every part must have a design condition under which it is
the correct choice. Anything without an answer gets removed. The schema
half of this contract is enforced by `src/physics/roster.test.ts` (every
part cited, propulsion typed, physical fields self-consistent).

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

## Control authority, by regime (all four non-dominated)

gimbal — free, needs thrust · active fins — free, needs q ·
CMG — free anywhere, weak, saturates · RCS — works anywhere, spends propellant (and settles tanks).

## Mechanics that keep this table honest

- Tank dry mass scales with **volume** (35 kg/m³), or hydrogen would be free.
- **Boiloff** (per-fluid scalar), or hypergolic would not exist.
- **Ullage + ignition budgets**: restarts are performed, not tooltip numbers.
- **Flow separation destroys** vacuum nozzles at low altitude: staging is physics.
- **Cluster mount mass** (estimate anchored to S-IC/octaweb): N small engines no longer strictly dominate one big one — RD-180 vs 4× Merlin is a real choice.
- **Solid commitment**: once lit, the grain decides.
