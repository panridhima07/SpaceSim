# Physics: open-source engines, ideas to borrow, compute plan

Written 2026-11-27. License and maintenance notes come from web search snippets and were not all
checked against the repos' license files; confirm before shipping anything that bundles third-party code.

## Do not replace our engine

No open-source engine does what ASTRA's two sims do and runs in a browser. The model-rocket tools
(OpenRocket, RocketPy, MAPLEAF) are Java/Python, and the orbital tools (Orekit, Basilisk, GMAT, Trick)
are Java/C++ desktop or server software. Keep `src/physics` and `rocket-physics`. Use the libraries
below for narrow jobs, and the rest as references and validation data.

## Libraries worth using directly (browser-ready, permissive)

| Library | License | Use in ASTRA |
|---|---|---|
| astronomy-engine (npm, TS) | MIT | Sun/Moon ephemeris for the lunar module and third-body gravity; could replace `rocket-physics/src/env/ephemeris.ts` and add eclipses and lighting |
| satellite.js / ootk-core | MIT | SGP4/TLE: show real satellites, validate orbits after insertion |
| Rapier (`@dimforge/rapier3d`, WASM) | Apache-2.0 | Only for real contact: landing legs, lunar touchdown, debris tumbling. A ground plane is cheaper for everything else |
| nrlmsise-00 (WASM port) | Apache-2.0 (check) | Optional thermosphere density for drag on low orbits; US1976 is enough below 86 km |
| JSBSim via `jsbsim-wasm` | LGPL-2.1, unofficial build | Not recommended: LGPL relinking rules, early wrapper |

## References for validation and design

- **OpenRocket** (GPL-3, Java): extended Barrowman CP and stability, pink-noise turbulence (1/f^(5/3)),
  the standard simulation outputs. GPL: re-derive from its technical documentation, never copy code.
  Its `.ork` example rockets are our best validation set (already used in `fixtures/external`).
- **RocketPy** (MIT, Python): 6-DOF with Monte Carlo dispersion, sensitivity analysis, weather ingestion
  (GFS/ERA5 soundings), parachute trigger model. Its published flights with telemetry (e.g. NDRT, Valetudo)
  are ready-made validation cases for `src/physics`.
- **MAPLEAF** (MIT, Python): seeded Kasdin coloured-noise turbulence, so Monte Carlo runs repeat exactly.
- **Orekit** (Apache-2.0, Java) / **hapsira** (MIT, Python, maintained poliastro fork): reference values for
  Kepler, Lambert and J2 propagation tests in `rocket-physics`.
- **Basilisk** (ISC) and **NASA Trick** (NOSA): architecture of modular dynamics plus a flight-software loop;
  reference only.
- **Principia** (MIT, KSP mod): symplectic integrators for long coasts with bounded energy drift.

## Compute: done in this round

`src/physics/sim.ts` (builder flights, stress test):

- Substeps grow from 2 ms to 20 ms once every deployed canopy is fully open and has settled for 1 s
  (`CANOPY_SUBSTEP`, `CANOPY_SETTLE_TIME`). The descent was about 94% of the substeps.
- Canopy rotational damping now acts per body axis (`-CHUTE_DAMPING_RATE * I * omega`). Before, the
  pitch inertia was applied to all three axes, which made roll damping about 1,500/s on a slender rocket:
  a stiff term that forced tiny steps. At 2 ms the two versions give the same results to the printed digits.
- Touchdown now goes back to the exact ground crossing (position, velocity, time interpolated within the
  last substep), so landing point, time and speed no longer depend on the step size.

Measured on the fixture C6 rocket (4 m/s wind, 20% gust):

| | Before | After |
|---|---|---|
| One flight (120 s of sim) | 103 ms | 38 ms |
| Stress test (19 flights) | 1,689 ms | 467 ms |
| Apogee / drift / landing speed (4 m/s case) | 369.86 m / 612.77 m / 4.33 m/s | 369.86 m / 612.77 m / 4.33 m/s |

Across all 19 stress cases, landing speeds stay within about 1% of the 2 ms results, and apogee and
drift match to the centimetre.

## Compute: next, in priority order

1. **Live builder flight off the main thread: decided against (2026-11-27).** Measured: about 4 µs per
   substep, so a frame at the atmosphere warp cap (10x, ~83 substeps) costs about 0.3 ms on desktop. The
   only heavy frames were coasting above 100 km at up to 10,000x warp (2,000 substeps of 0.1 s). The app reads
   `sim.state`, `sim.log` (trail) and `sim.events` synchronously every frame, a server replay implements the
   same `Sim` interface, and hand-flown controls would gain a frame of lag. So the heavy case was fixed in
   the sim instead: above 100 km the coast step now grows to 1 s while the body turns less than 0.1 rad per
   step and the dynamic pressure is under 1 Pa (`COAST_SUBSTEP_MAX`, `COAST_TURN`, `COAST_MAX_Q`), and it stays
   0.1 s while hand-flown. That is 10x fewer coast substeps; in a 500 km stub flight the impact time and
   point match the 0.1 s run to 0.1 m. The apogee event is now interpolated within the substep, like touchdown.
   Still open: a frame that starts just above 100 km while descending at high warp runs the rest of its
   sim time at 2 ms (up to `MAX_SUBSTEPS_PER_CALL`), one spike per flight. Capping the warp from the
   descent rate would remove it.
2. **`rocket-physics` is already tuned; leave it unless a profile changes.** Profiled 2026-11-27
   (`node --cpu-prof bench/bench.ts`; bench: two-stage ascent 265 ms, LVM3 to GTO 321 ms, 10-day LEO 133 ms).
   No function is above 13% of the time; the whole evaluate path is about 45%, the garbage collector 6.5%.
   Two ideas from an earlier read do not hold up. The `refresh()` evaluate is not a duplicate of the next
   RK4 stage: the autopilot changes gimbal, throttle and RCS in between. The finite-difference inertia
   pass is cheap (`MassModel.evaluate` is a few multiply-adds per tank). What is left (fewer allocations in
   `unpack` and the coast solver, a warm start for `solveGeodetic`) is worth 10-15% at most, and every one
   of them changes the bench fingerprints in the last digits.
3. **Adaptive stepping for `src/physics` boost and coast** (Dormand–Prince 5(4) with event location by
   root-finding for burnout, apogee and deploy), as RocketPy and Orekit do. Bigger change: it needs
   validation against the `.ork` fixtures first.
4. **Run Monte Carlo and the stress test in parallel**: one Worker per core in the browser,
   `worker_threads` in `api/simulate.ts`. The 19 stress cases are independent.

## Fidelity: next, borrowed ideas

- Seeded coloured-noise turbulence (MAPLEAF/OpenRocket) to replace the fixed `sin*sin` gust in `wind.ts`.
- Weather soundings (RocketPy style) feeding `windLayers` and the atmosphere.
- Monte Carlo dispersion on the builder rocket (motor impulse ±, Cd ±, mass ±, wind), with a
  landing-ellipse plot. The `rocket-physics/src/sim/montecarlo.ts` structure can be reused.
- A validation page: ASTRA against OpenRocket/RocketPy results for the same `.ork` files.
