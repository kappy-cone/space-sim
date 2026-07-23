// Part roster: real engines with published figures, tanks defined by
// VOLUME (dry mass scales with volume — see propellants.ts). Every figure
// carries its source; derived or estimated values are flagged as such.
//
// Model notes:
// - ṁ = F_vac/(g₀·Isp_vac) is constant; thrust varies linearly with
//   ambient pressure at fixed ṁ. Where a manufacturer publishes only
//   three of {F_sl, F_vac, Isp_sl, Isp_vac}, the fourth is derived for
//   self-consistency and marked "derived".
// - maxAmbientPressure is derived per engine via the Summerfield
//   criterion (flow separates when p_exit < ~0.4·p_ambient) using the
//   published expansion ratio and chamber pressure; firing above the
//   limit DESTROYS the engine (separation side loads), it does not
//   merely underperform.
// - Solids: rated thrust = total impulse (prop·g₀·Isp_vac) / burn time,
//   so the constant-ṁ model reproduces the real burn duration; the
//   thrust curve is digitized approximately from published thrust-time
//   plots and normalized to that rating.

import { Engine, Tank } from './vehicle';
import { propellantById, TANK_STRUCTURE_KG_PER_M3 } from './propellants';

export const ENGINES: readonly Engine[] = [
  // ---------------- kerolox ----------------
  {
    id: 'merlin-1d',
    name: 'Merlin 1D',
    propellant: 'kerolox',
    thrustSL: 845_000, // 190,000 lbf — SpaceX Falcon 9 page
    thrustVac: 931_861, // derived = 845·(311/282)
    ispSL: 282, // Falcon User's Guide
    ispVac: 311,
    mass: 470, // incl. TVC — Tom Mueller (SpaceX), 2015
    vacuumOnly: false,
    source: 'SpaceX Falcon 9 page + Falcon User Guide; F_vac derived; mass T. Mueller 2015',
    throttleable: true,
    minThrottle: 0.4, // reported ~40% (SpaceX statements — estimate)
    ignitions: 3, // TEA-TEB igniter sized for boostback/entry/landing (profile estimate)
    gimbalDeg: 5, // not formally published; F9 TVC class — ESTIMATE
    expansionRatio: 16, // SpaceX published
    maxAmbientPressure: Infinity, // sea-level nozzle
    ullageImmune: false,
  },
  {
    id: 'merlin-vac',
    name: 'Merlin 1D Vacuum',
    propellant: 'kerolox',
    thrustSL: 0,
    thrustVac: 981_000, // 220,500 lbf — SpaceX
    ispSL: 0,
    ispVac: 348, // SpaceX
    mass: 600, // ESTIMATE (M1D + radiatively cooled extension); never published
    vacuumOnly: true,
    source: 'SpaceX Falcon 9 page; mass estimate flagged; ε 165 published',
    throttleable: true,
    minThrottle: 0.39, // reported minimum (estimate)
    ignitions: 3, // multi-burn GTO missions routine (profile estimate)
    gimbalDeg: 5, // ESTIMATE, M1D-class TVC
    expansionRatio: 165,
    // Summerfield: p_exit ≈ 5.3 kPa (ε 165, Pc 9.7 MPa, γ≈1.22) → separation
    // above ~13 kPa ambient (≈15 km). Derived.
    maxAmbientPressure: 13_000,
    ullageImmune: false,
  },
  {
    id: 'rd-180',
    name: 'RD-180',
    propellant: 'kerolox',
    thrustSL: 3_827_000, // 860.6 klbf — P&W/ULA Atlas V data
    thrustVac: 4_152_000, // 933.4 klbf — same
    ispSL: 311.3, // ULA/P&W fact sheet
    ispVac: 337.8,
    mass: 5_480, // dry — P&W fact sheet
    vacuumOnly: false,
    source: 'Pratt & Whitney / ULA RD-180 and Atlas V data sheets',
    throttleable: true,
    minThrottle: 0.47, // 47–100% continuous throttle — ULA published
    ignitions: 1, // ground-lit, no flight restart on Atlas V
    gimbalDeg: 8, // ±8° — ULA
    expansionRatio: 36.9, // published
    maxAmbientPressure: Infinity, // sea-level engine
    ullageImmune: false,
  },
  {
    id: 'rutherford',
    name: 'Rutherford',
    propellant: 'kerolox',
    thrustSL: 24_900, // Electron Payload User's Guide
    thrustVac: 25_557, // derived = 24.9·(311/303)
    ispSL: 303, // circulated ESTIMATE (low confidence); vac 311 published
    ispVac: 311,
    mass: 35, // Rocket Lab, 100th engine build
    vacuumOnly: false,
    source: 'Rocket Lab Electron pages / Payload User Guide; Isp_sl estimate flagged',
    throttleable: true,
    minThrottle: 0.2, // LOW-CONFIDENCE ESTIMATE (electric pumps: deep throttle plausible)
    ignitions: 5, // spark-torch + electric pumps; ESTIMATE (battery-limited)
    gimbalDeg: 5, // ESTIMATE
    expansionRatio: 14, // ESTIMATE (sea-level Rutherford; not published)
    maxAmbientPressure: Infinity,
    ullageImmune: false,
  },
  // ---------------- methalox ----------------
  {
    id: 'raptor-2',
    name: 'Raptor 2',
    propellant: 'methalox',
    thrustSL: 2_256_000, // 230 tf — SpaceX post, Aug 2024
    thrustVac: 2_393_982, // derived = 2256·(347/327)
    ispSL: 327, // Starship presentation 2018
    ispVac: 347, // SpaceX 2024
    mass: 1_630, // engine-only — SpaceX post, Aug 2024
    vacuumOnly: false,
    source: 'SpaceX posts/presentations (2018–2024); F_vac derived; ε ≈ 34 (Raptor SL class, approximate)',
    throttleable: true,
    minThrottle: 0.5, // ~50% reported (SpaceX statements — estimate)
    ignitions: Infinity, // spark-torch ignition, designed for unlimited relights
    gimbalDeg: 5, // not published — ESTIMATE (SL center-engine TVC class)
    expansionRatio: 34.3, // Raptor sea-level nozzle class — approximate
    maxAmbientPressure: Infinity,
    ullageImmune: false,
  },
  // ---------------- hydrolox ----------------
  {
    id: 'rs-25',
    name: 'RS-25',
    propellant: 'hydrolox',
    thrustSL: 1_860_000, // 109% RPL — L3Harris/NASA SLS
    thrustVac: 2_279_000,
    ispSL: 366, // published pair ~1% off constant-ṁ; kept as published
    ispVac: 452.3,
    mass: 3_527, // 7,775 lb — Aerojet Rocketdyne
    vacuumOnly: false,
    source: 'L3Harris/Aerojet Rocketdyne RS-25 page; NASA SLS fact sheet',
    throttleable: true,
    minThrottle: 67 / 109, // NASA: 67–109% RPL; our rating is the 109% point
    ignitions: 1, // ground-lit only — no flight restart
    gimbalDeg: 10.5, // ±10.5° pitch/yaw — NASA
    expansionRatio: 69, // published
    maxAmbientPressure: Infinity, // runs at sea level (Pc 20.6 MPa)
    ullageImmune: false,
  },
  {
    id: 'j-2',
    name: 'J-2',
    propellant: 'hydrolox',
    thrustSL: 0,
    thrustVac: 1_033_100, // 232,250 lbf — NASA Saturn V references (SP-4206)
    ispSL: 0,
    ispVac: 421, // NASA
    mass: 1_788, // 3,942 lb — NASA
    vacuumOnly: true,
    source: 'NASA Saturn V / J-2 references (SP-4206 class); ε 27.5, Pc 5.26 MPa published',
    throttleable: false,
    minThrottle: 1, // fixed thrust (two-position MR shift not modeled)
    ignitions: 2, // S-IVB flew one restart — the canonical ullage customer
    gimbalDeg: 7, // ±7° class on S-IVB — NASA
    expansionRatio: 27.5,
    // Summerfield: p_exit ≈ 32 kPa (ε 27.5, Pc 5.26 MPa) → separation above
    // ~80 kPa (≈2 km). Derived — an upper-stage engine that survives a
    // high-altitude air start but not a pad start.
    maxAmbientPressure: 80_000,
    ullageImmune: false,
  },
  {
    id: 'rl10b-2',
    name: 'RL10B-2',
    propellant: 'hydrolox',
    thrustSL: 0,
    thrustVac: 110_100, // 24,750 lbf — L3Harris / ULA Delta IV
    ispSL: 0,
    ispVac: 465.5, // deployed (285:1) — L3Harris/ULA
    mass: 301, // 664 lb — fact sheet
    vacuumOnly: true,
    source: 'L3Harris RL10 / ULA Delta IV data; extendable nozzle 285:1 published',
    throttleable: false,
    minThrottle: 1, // fixed thrust in flight
    ignitions: 3, // multiple-restart qualified; typical profiles ≤3 (ESTIMATE)
    gimbalDeg: 4, // EMA TVC, ±4° class — ULA (approximate)
    expansionRatio: 285,
    // Summerfield: p_exit ≈ 1.3 kPa (ε 285, Pc 4.4 MPa) → separation above
    // ~3.3 kPa (≈20 km). Derived.
    maxAmbientPressure: 3_300,
    ullageImmune: false,
    // Stowed: the fixed portion of the bell (~77:1 per the design brief;
    // stowed Isp derived −30 s). Deploy before full-performance burns.
    nozzleExtension: { stowedExpansionRatio: 77, stowedIspVac: 435.5, stowedMaxAmbientPressure: 16_000 },
  },
  // ---------------- hypergolic ----------------
  {
    id: 'aj10-190',
    name: 'AJ10-190 (OMS)',
    propellant: 'hypergolic',
    thrustSL: 0,
    thrustVac: 26_700, // 6,000 lbf — Aerojet/NASA Shuttle OMS
    ispSL: 0,
    ispVac: 316, // NASA Shuttle OMS
    mass: 118, // Aerojet
    vacuumOnly: true,
    source: 'Aerojet Rocketdyne / NASA Space Shuttle OMS engine data',
    throttleable: false,
    minThrottle: 1, // pressure-fed, fixed thrust
    ignitions: Infinity, // qualified for hundreds of starts (OMS: 1000-start class)
    gimbalDeg: 6, // OMS pitch/yaw class — NASA
    expansionRatio: 55, // published
    // Summerfield: p_exit ≈ 1.9 kPa (ε 55, Pc 0.86 MPa) → ~4.7 kPa limit.
    maxAmbientPressure: 4_700,
    // Pressure-fed with propellant-management devices (surface-tension
    // screens hold liquid at the outlet): lights in freefall, every time.
    // This is the reliable, low-Isp answer to the ullage problem — its
    // reason to exist.
    ullageImmune: true,
  },
  // ---------------- solids ----------------
  {
    id: 'gem-40',
    name: 'GEM-40 (solid)',
    propellant: 'solid',
    // Rated = total impulse / burn: 11,766 kg × g₀ × 274 s / 63.3 s.
    thrustSL: 452_000, // SL ≈ vac × (267/274): SL Isp ~267 (Delta II class)
    thrustVac: 499_500,
    ispSL: 267,
    ispVac: 274, // Delta II payload planners guide (GEM-40 class figures)
    mass: 1_361, // inert (case + nozzle) — Delta II GEM data
    vacuumOnly: false,
    source: 'Boeing/NG Delta II GEM-40 data (prop 11,766 kg, 63.3 s, Isp 274); rating derived from total impulse',
    throttleable: false,
    minThrottle: 1,
    ignitions: 1,
    gimbalDeg: 0, // fixed nozzle
    expansionRatio: 16, // ESTIMATE (not published for GEM-40)
    maxAmbientPressure: Infinity,
    ullageImmune: true,
    // Regressive grain, approximated from Delta II GEM thrust-time plots.
    thrustCurve: [
      [0, 1.12],
      [0.25, 1.15],
      [0.55, 1.0],
      [0.85, 0.8],
      [0.96, 0.5],
      [1, 0],
    ],
  },
  {
    id: 'rsrm',
    name: 'RSRM (solid)',
    propellant: 'solid',
    // Rated = total impulse / burn: 501,700 kg × g₀ × 268.2 s / 123.4 s.
    thrustSL: 10_200_000, // SL ≈ vac × (242/268.2): SL Isp 242 — NASA
    thrustVac: 10_695_000,
    ispSL: 242,
    ispVac: 268.2, // NASA RSRM data
    mass: 87_300, // inert (steel case, nozzle, TVC) — NASA
    vacuumOnly: false,
    source: 'NASA Space Shuttle RSRM data (prop 501.7 t, 123.4 s, Isp 268.2/242); rating derived from total impulse; curve digitized approximately from NASA thrust-time plots',
    throttleable: false,
    minThrottle: 1,
    ignitions: 1,
    gimbalDeg: 8, // ±8° flex-bearing TVC — NASA
    expansionRatio: 7.7, // published (7.72)
    maxAmbientPressure: Infinity,
    ullageImmune: true,
    // The mid-burn thrust reduction for max-q relief is grain-shaped and
    // deliberate — the canonical thrust-curve example. It must be visible
    // in the flight data.
    thrustCurve: [
      [0, 1.05],
      [0.16, 1.25],
      [0.35, 0.95],
      [0.45, 0.78], // max-q bucket, t ≈ 50–60 s
      [0.55, 0.8],
      [0.7, 1.0],
      [0.85, 0.95],
      [0.94, 0.55],
      [1, 0],
    ],
  },
  {
    id: 'tx-280',
    name: 'TX-280 ullage motor (solid)',
    propellant: 'solid',
    // Saturn S-II class ullage motor: ~15.1 kN for ~3.9 s (NASA Saturn V
    // references). Prop from impulse: 15.1 kN × 3.87 s / (g₀·235 s) ≈ 25 kg.
    thrustSL: 14_800,
    thrustVac: 15_100,
    ispSL: 230, // small-solid class — ESTIMATE
    ispVac: 235,
    mass: 27, // case inert — ESTIMATE (loaded ~52 kg)
    vacuumOnly: false,
    source: 'NASA Saturn V S-II ullage motor references (TX-280 class, 15.1 kN / 3.87 s); Isp and case mass estimates flagged',
    throttleable: false,
    minThrottle: 1,
    ignitions: 1,
    gimbalDeg: 0,
    expansionRatio: 8, // ESTIMATE
    maxAmbientPressure: Infinity,
    ullageImmune: true,
    thrustCurve: [
      [0, 1.1],
      [0.8, 1.0],
      [1, 0],
    ],
  },
  {
    id: 'mk36',
    name: 'Mk 36 rocket motor (solid)',
    propellant: 'solid',
    // Air-to-air missile boost motor (AIM-9 Sidewinder class). The whole
    // point of the re-engine: a rocket, not a jet — it reaches M2.5+
    // where a light turbojet is stuck subsonic. Rated thrust from
    // impulse: 35 kg grain × g₀ × 235 s / 5.0 s ≈ 16.1 kN.
    thrustSL: 15_600, // SL ≈ vac × (228/235) — low-expansion tactical nozzle
    thrustVac: 16_100,
    ispSL: 228,
    ispVac: 235, // small reduced-smoke solid class — ESTIMATE within range
    mass: 12, // motor case + nozzle inert — ESTIMATE (Sidewinder motor class)
    vacuumOnly: false,
    source:
      'AIM-9 Sidewinder Mk 36 class boost motor: burnout M2.5+ published; grain 35 kg / burn ~5 s / Isp 235 s ESTIMATED within reduced-smoke tactical-solid ranges (Zarchan, Tactical and Strategic Missile Guidance; public Sidewinder data). Sea-level-capable low-expansion nozzle.',
    throttleable: false,
    minThrottle: 1,
    ignitions: 1,
    gimbalDeg: 0, // spin-stabilized / fin-controlled, not TVC
    expansionRatio: 5, // sea-level tactical nozzle — ESTIMATE
    maxAmbientPressure: Infinity,
    ullageImmune: true,
    // Boost motor: near-flat then sharp tail-off (reduced-smoke grain).
    thrustCurve: [
      [0, 1.1],
      [0.1, 1.15],
      [0.85, 1.0],
      [1, 0],
    ],
  },
  // ---------------- air-breathing (plane class) ----------------
  // Model: thrust = T_SL·(ρ/ρ₀)·f(M), ṁ = tsfc·T (fuel only — no
  // oxidizer aboard, which is the entire point: fuel-only Isp = 3600/TSFC
  // [lb/lbf/hr] runs ~20× a kerolox rocket). One TSFC per engine (its
  // cruise/design value); low-speed fuel flow is overestimated by the
  // single-number model — flagged, not hidden. ispVac = ispSL =
  // 1/(tsfc·g₀) and thrustVac = thrustSL keep the stage aggregates
  // self-consistent at the reference point. Three engines, three Mach
  // bands, each provably winning in its own (docs/PARTS.md).
  {
    id: 'cfm56',
    name: 'CFM56-5B4 turbofan',
    propellant: 'jetfuel',
    thrustSL: 120_100, // 27,000 lbf takeoff — EASA TCDS E.003 (CFM56-5B4)
    thrustVac: 120_100, // = SL (the (ρ/ρ₀)·f(M) model owns the lapse)
    ispSL: 6_605, // = 1/(tsfc·g₀) = 3600/0.545 hr⁻¹
    ispVac: 6_605,
    mass: 2_380, // dry — EASA TCDS E.003
    vacuumOnly: false,
    source:
      'EASA TCDS E.003 (thrust, mass); cruise TSFC 0.545 lb/lbf/hr (type references) — single-TSFC model overestimates static fuel flow, flagged; f(M) anchored to published ~23–26 kN cruise thrust at M0.8/FL350, intermediate points ESTIMATED',
    throttleable: true,
    minThrottle: 0.05, // flight idle — ESTIMATE
    ignitions: Infinity, // windmill/starter relight
    gimbalDeg: 0,
    expansionRatio: 1.1, // fan nozzle, near-unity — not meaningful for jets
    maxAmbientPressure: Infinity,
    ullageImmune: true, // pumps are shaft-driven; no settling requirement
    airBreathing: {
      // High-bypass ram-drag lapse. f(0.8) anchors the published cruise
      // thrust (~23–26 kN at M0.8/FL350) IN THIS SIM'S ATMOSPHERE — the
      // piecewise-exponential density model reads ~25% low at 11 km, so
      // the table absorbs that bias rather than hiding it (the pinned
      // calibration test is the contract; see engines.test.ts).
      machTable: [
        [0, 1],
        [0.4, 0.88],
        [0.8, 0.827],
        [0.95, 0.78],
      ],
      minMach: 0,
      maxMach: 0.95, // transonic fan/inlet limit (type operating envelope)
      rhoFloor: 0.28, // ≈ 12.6 km — 737-class 41,000 ft ceiling (derived)
      tsfc: 1.5437e-5, // 0.545 lb/lbf/hr → kg/(N·s)
    },
  },
  {
    id: 'j79',
    name: 'J79-GE-17 turbojet (afterburning)',
    propellant: 'jetfuel',
    thrustSL: 79_620, // 17,900 lbf max afterburner — USAF/GE J79-17 data
    thrustVac: 79_620,
    ispSL: 1_832, // = 3600/1.965 hr⁻¹ (max A/B TSFC)
    ispVac: 1_832,
    mass: 1_745, // dry — GE J79 data
    vacuumOnly: false,
    source:
      'GE/USAF J79-GE-17 published data (thrust, mass, A/B TSFC 1.965 lb/lbf/hr); modeled in max afterburner — its supersonic-band role; f(M) ram-thrust shape ESTIMATED from installed J79 curves',
    throttleable: true,
    minThrottle: 0.05, // ESTIMATE (mil power and below collapsed into one lever)
    ignitions: Infinity,
    gimbalDeg: 0,
    expansionRatio: 1.5,
    maxAmbientPressure: Infinity,
    ullageImmune: true,
    airBreathing: {
      // Afterburning turbojet: ram recovery holds thrust up through M2.
      machTable: [
        [0, 1],
        [1.0, 1.08],
        [2.0, 1.25],
        [2.2, 1.2],
      ],
      minMach: 0,
      maxMach: 2.2, // F-4-class placard (inlet temperature limit)
      rhoFloor: 0.115, // ≈ 18.3 km — F-4 service ceiling class (derived)
      tsfc: 5.566e-5, // 1.965 lb/lbf/hr → kg/(N·s)
    },
  },
  {
    id: 'rj43',
    name: 'RJ43-MA-3 ramjet',
    propellant: 'jetfuel',
    thrustSL: 50_000, // ~11–12,000 lbf class at design point — Marquardt Bomarc data, ESTIMATE within cited range
    thrustVac: 50_000,
    ispSL: 1_333, // = 3600/2.7 hr⁻¹
    ispVac: 1_333,
    mass: 300, // no turbomachinery — Bomarc/X-7 unit class, ESTIMATE
    vacuumOnly: false,
    source:
      'Marquardt RJ43-MA-3 (Bomarc A; X-7 testbed reached M4.31): thrust class and mass ESTIMATED from cited ranges; ramjet TSFC ~2.7 lb/lbf/hr at M2.5+ (Mattingly, Elements of Gas Turbine Propulsion, ramjet class values) — ESTIMATE',
    throttleable: true,
    minThrottle: 0.5, // ramjets throttle poorly (fuel-flow stability) — ESTIMATE
    ignitions: Infinity,
    gimbalDeg: 0,
    expansionRatio: 2,
    maxAmbientPressure: Infinity,
    ullageImmune: true,
    airBreathing: {
      // No static thrust: a ramjet needs ram compression. The BOOST TO
      // LIGHT is the mechanic — carry another engine to Mach 1.8 first.
      machTable: [
        [1.8, 0.5],
        [2.5, 1.0],
        [3.5, 1.1],
        [4.3, 0.9],
      ],
      minMach: 1.8, // light-off boost requirement (Bomarc boosted past M2)
      maxMach: 4.3, // X-7/RJ43 flight record M4.31
      rhoFloor: 0.018, // ≈ 30 km — X-7 class ceiling (derived)
      tsfc: 7.648e-5, // 2.7 lb/lbf/hr → kg/(N·s)
    },
  },
];

// ---------------- tanks (volume-first) ----------------

const tank = (id: string, name: string, fluid: 'kerolox' | 'hydrolox' | 'hypergolic', volume: number): Tank => ({
  id,
  name,
  fluid,
  volume,
  propellantMass: Math.round(volume * propellantById(fluid).bulkDensity),
  dryMass: Math.round(volume * TANK_STRUCTURE_KG_PER_M3),
  source: 'Structure 35 kg/m³ derived from F9 S2 + Saturn S-IVB structural fractions (propellants.ts)',
});

/** Legacy fixed tanks (test vehicles); the builder's tanks are parametric
 * (fluid × diameter, length as a build-time parameter). Volumes chosen to
 * keep the historical kerolox load labels. */
export const TANKS: readonly Tank[] = [
  tank('tank-xs', 'Tank XS (2 t kerolox)', 'kerolox', 1.955),
  tank('tank-s', 'Tank S (10 t kerolox)', 'kerolox', 9.775),
  tank('tank-m', 'Tank M (40 t kerolox)', 'kerolox', 39.1),
  tank('tank-l', 'Tank L (110 t kerolox)', 'kerolox', 107.53),
  tank('tank-xl', 'Tank XL (400 t kerolox)', 'kerolox', 391.0),
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
