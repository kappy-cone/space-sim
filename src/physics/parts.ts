// Part roster: real engines with published figures, tanks with realistic
// structural fractions. Every figure carries its source; values that are
// derived or estimates (not published) are flagged as such.
//
// Model note: the sim keeps ṁ constant (= F_vac/(g₀·Isp_vac)) and varies
// thrust linearly with ambient pressure. Publishing all four of
// {F_sl, F_vac, Isp_sl, Isp_vac} over-determines that model, so where a
// manufacturer publishes only three, the fourth is derived for exact
// self-consistency (F_vac = F_sl·Isp_vac/Isp_sl) and marked "derived".

import { Engine, Tank } from './vehicle';

export const ENGINES: readonly Engine[] = [
  {
    id: 'merlin-1d',
    name: 'Merlin 1D',
    // F_sl 845 kN (190,000 lbf) — SpaceX Falcon 9 vehicle page.
    thrustSL: 845_000,
    // F_vac derived = 845·(311/282) ≈ 932 kN. SpaceX has published no clean
    // Block-5 vacuum thrust (a 2016 announcement targeted 914 kN).
    thrustVac: 931_861,
    // Isp 282 s SL / 311 s vac — SpaceX Falcon User's Guide figures.
    ispSL: 282,
    ispVac: 311,
    // 470 kg incl. TVC actuators — Tom Mueller (SpaceX propulsion CTO), 2015.
    mass: 470,
    vacuumOnly: false,
    // Throttle 40% reported for Merlin 1D (SpaceX statements, not a formal
    // datasheet figure — treat as an estimate). TEA-TEB igniter capacity
    // sized for the flown boostback/entry/landing profile: 3 lights
    // (ESTIMATE from flight profiles; never published).
    minThrottle: 0.4,
    ignitions: 3,
  },
  {
    id: 'merlin-vac',
    name: 'Merlin 1D Vacuum',
    thrustSL: 0,
    // 981 kN (220,500 lbf) — SpaceX Falcon 9 page.
    thrustVac: 981_000,
    ispSL: 0,
    // 348 s — SpaceX Falcon 9 page.
    ispVac: 348,
    // ESTIMATE ~600 kg (M1D 470 kg + nozzle extension); never published.
    mass: 600,
    vacuumOnly: true, // radiatively-cooled nozzle would flow-separate at 1 atm
    // ~39% reported minimum (SpaceX statements — estimate). Multi-burn GTO
    // missions demonstrate 3 lights routinely (ESTIMATE from profiles).
    minThrottle: 0.39,
    ignitions: 3,
  },
  {
    id: 'rs-25',
    name: 'RS-25',
    // Figures at 109% RPL (SLS operating point) — L3Harris/Aerojet Rocketdyne
    // RS-25 page & NASA SLS fact sheet: 1860 kN SL / 2279 kN vac.
    thrustSL: 1_860_000,
    thrustVac: 2_279_000,
    // 366 s SL / 452.3 s vac — L3Harris RS-25 page. (Published pair is ~1%
    // off the constant-ṁ model; kept as published, display-only for SL.)
    ispSL: 366,
    ispVac: 452.3,
    // 3527 kg (7,775 lb) — Aerojet Rocketdyne data.
    mass: 3_527,
    vacuumOnly: false,
    // NASA: 67%-109% RPL power range; our rated point is 109%, so the
    // floor is 67/109. Ground-lit only — no flight restart capability.
    minThrottle: 67 / 109,
    ignitions: 1,
  },
  {
    id: 'raptor-2',
    name: 'Raptor 2',
    // F_sl 2256 kN (230 tf) — SpaceX post, Aug 2024.
    thrustSL: 2_256_000,
    // F_vac derived = 2256·(347/327) ≈ 2394 kN; not separately published.
    thrustVac: 2_393_982,
    // Isp 327 s SL (Starship presentation 2018) / 347 s vac (SpaceX, 2024).
    ispSL: 327,
    ispVac: 347,
    // 1630 kg engine-only — SpaceX post, Aug 2024.
    mass: 1_630,
    vacuumOnly: false,
    // ~50% reported minimum (SpaceX statements — estimate). Spark-torch
    // ignition, designed for unlimited in-flight relights.
    minThrottle: 0.5,
    ignitions: Infinity,
  },
  {
    id: 'rl10b-2',
    name: 'RL10B-2',
    thrustSL: 0,
    // 110.1 kN (24,750 lbf) — L3Harris RL10 page / ULA Delta IV page.
    thrustVac: 110_100,
    ispSL: 0,
    // 465.5 s — L3Harris and ULA both list it.
    ispVac: 465.5,
    // 301 kg (664 lb) — Aerojet/L3Harris fact sheet.
    mass: 301,
    vacuumOnly: true, // 280:1 extendable nozzle, upper-stage only
    // Fixed-thrust in flight (RL10B-2 is not throttleable). Multiple-
    // restart qualified; typical mission profiles use up to 3 lights
    // (ESTIMATE - qualification numbers are not public).
    minThrottle: 1,
    ignitions: 3,
  },
  {
    id: 'rutherford',
    name: 'Rutherford',
    // F_sl 24.9 kN (5,600 lbf) — Electron Payload User's Guide. (Rocket
    // Lab's site currently rounds to 24 kN; sources disagree.)
    thrustSL: 24_900,
    // F_vac derived = 24.9·(311/303) ≈ 25.6 kN.
    thrustVac: 25_557,
    // Isp_vac 311 s — Rocket Lab Electron pages. Isp_sl is NOT published:
    // 303 s is a circulated ESTIMATE (low confidence).
    ispSL: 303,
    ispVac: 311,
    // 35 kg — Rocket Lab, "100th Rutherford Engine Build".
    mass: 35,
    vacuumOnly: false,
    // Electric-pump feed makes deep throttling plausible; no figure is
    // published - 20% is a LOW-CONFIDENCE ESTIMATE. Relights: the second
    // stage engine performs restart burns; 2 lights (ESTIMATE).
    minThrottle: 0.2,
    ignitions: 2,
  },
];

// Tank structure ≈ 4.5% of propellant mass (engines are separate parts).
// Basis: Falcon 9 FT stage estimates (spaceflight101.com): S1 22.2 t dry
// incl. ~4.2 t engines over 411 t propellant → tank+structure ≈ 4.4%;
// S2 ≈ 3.2%. 4.5% is a mild conservative round-up for smaller tanks.
const TANK_STRUCTURE_FRACTION = 0.045;

const tank = (id: string, name: string, propellantMass: number): Tank => ({
  id,
  name,
  propellantMass,
  dryMass: Math.round(propellantMass * TANK_STRUCTURE_FRACTION),
});

export const TANKS: readonly Tank[] = [
  tank('tank-xs', 'Tank XS (2 t)', 2_000),
  tank('tank-s', 'Tank S (10 t)', 10_000),
  tank('tank-m', 'Tank M (40 t)', 40_000),
  tank('tank-l', 'Tank L (110 t)', 110_000),
  tank('tank-xl', 'Tank XL (400 t)', 400_000),
];

export const engineById = (id: string): Engine => {
  const e = ENGINES.find((x) => x.id === id);
  if (!e) throw new Error(`unknown engine: ${id}`);
  return e;
};

export const tankById = (id: string): Tank => {
  const t = TANKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown tank: ${id}`);
  return t;
};
