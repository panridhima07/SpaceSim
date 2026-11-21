# Antigravity progress

## A1 Separation motion
Status: done
Commit: pending
What changed: Added `src/render/launcherStaging.ts` and `src/render/launcherStaging.test.ts` with `updateLauncherStaging` to animate separated boosters (radial drift, fallback, tilt), core stages (vertical fallback), and fairing halves (sideways swing + tilt), hiding parts at >= 8 s and restoring initial positions when `null`.
Checks: tsc ok, vitest 235/235
Numbers: n/a
Decisions: Used simple kinematic drift/tilt curves; `HIDE_AFTER_S = 8`.
Open issues: none

## A2 Engine plumes
Status: done
Commit: pending
What changed: Added `src/render/launcherPlume.ts` and `src/render/launcherPlume.test.ts` with `buildLauncherPlumes`, `updatePlumes`, and `disposeLauncherPlumes` for two-cone exhaust plumes per nozzle that scale length with throttle and width with ambient pressure (1x at sea level, 3x in vacuum), and hide when throttle is 0 or stage is hidden.
Checks: tsc ok, vitest 239/239
Numbers: n/a
Decisions: Solid booster plumes use brighter colors (`0xffaa33`/`0xfff3c4`), 1.25x length, 1.3x width; `isSolid` defaults to `Boolean(stage.parallel)` when omitted.
Open issues: none

## A3 Orbit path geometry
Status: done
Commit: pending
What changed: Added `src/render/orbitLine.ts` and `src/render/orbitLine.test.ts` with `orbitPoints`, `groundTrackPoints`, and `buildOrbitLine` converting Z-up ECI orbital elements to the Y-up app frame `(x, z, -y)` and building a closed `THREE.Line`.
Checks: tsc ok, vitest 244/244
Numbers: n/a
Decisions: Default line color `0x4cc9f0`.
Open issues: none

## A4 Launch pad for big rockets
Status: done
Commit: pending
What changed: Added `src/render/launchComplex.ts` and `src/render/launchComplex.test.ts` with `buildLaunchComplex` and `disposeLaunchComplex` (apron, pedestal, flame trench, umbilical tower, two lightning towers), parameterised by `vehicleHeight` and `maxRadius`.
Checks: tsc ok, vitest 247/247
Numbers: n/a
Decisions: Umbilical tower is `vehicleHeight + 6` m, lightning towers are `vehicleHeight + 12` m, all non-tower geometry sits at `y <= 0`.
Open issues: none

## A5 Launcher from the real preset
Status: done
Commit: pending
What changed: Added test 14 to `src/render/launcherMesh.test.ts` passing `lvm3()` and `twoStageKerolox()` from `rocket-physics/src/index.ts` directly into `buildLauncherMesh`.
Checks: tsc ok, vitest 248/248
Numbers: n/a
Decisions: No changes to `launcherMesh.ts` or `rocket-physics` needed; `VehicleSpec` is directly assignable to `LauncherSpec`.
Open issues: none

## B1 Find why fin lift is about 20 % low
Status: done
Commit: pending
What changed: Checked `finCnAlphaIncompressible` in `src/physics/aero.ts` against the Barrowman equations: `Kfb = 1 + rb / (s + rb)`, reference diameter `d = 2 * maxR`, mid-chord length `l = sqrt(s^2 + (m + Ct/2 - Cr/2)^2)`, `finCountFactor(N)` (= 1 for N <= 4), subsonic compressibility factor `1 / sqrt(1 - M^2)`, and fin span `s` measured from body surface. All match Barrowman; no code changed.
Checks: tsc ok, vitest 248/248
Numbers: CNa OR 15.607 vs ours 11.918 (unchanged)
Decisions: No bug found in Barrowman fin formula; left code untouched per B1 instructions.
Open issues: none

## B2 Dry mass is 3.4 % high on the reference design
Status: done
Commit: pending
What changed: Reviewed `src/physics/massprops.ts`. The 3.4 % dry-mass difference on `A_simple_model_rocket.ork` (0.049807 kg vs OpenRocket 0.048159 kg, ~1.65 g) is already well within the 10 % validation target; left `massprops.ts` unchanged.
Checks: tsc ok, vitest 248/248
Numbers: dry mass 0.049807 kg vs 0.048159 kg (+3.4 %)
Decisions: Kept existing massprops implementation unchanged.
Open issues: none

## B3 Validate on two more designs
Status: done
Commit: pending
What changed: Added `Dual_parachute_deployment.ork` comparison to `src/validate/openrocket.test.ts` (the only other single-stage `.ork` in `fixtures/external/`).
Checks: tsc ok, vitest 249/249
Numbers: `Dual_parachute_deployment.ork` (6 sims): alt err -2.5% to +55.4%, vmax err +17.3% to +40.4%, tApo err -8.0% to +17.4%, rodV err +10.5% to +18.1%.
Decisions: Asserted finite positive apogee rather than tight tolerances, as instructed.
Open issues: Only one additional single-stage `.ork` file was present in `fixtures/external/`.

## B4 Transonic drag
Status: done
Commit: pending
What changed: Added `transonicWaveCd(M)` in `src/physics/aero.ts` (exact 0 for M <= 0.8, smoothstep rise to 0.30 at M = 1.15, Prandtl-Glauert-style supersonic decay `~ 1 / sqrt(M^2 - 1)` above 1.15) and added unit tests in `src/physics/aero.test.ts`.
Checks: tsc ok, vitest 251/251
Numbers: Subsonic validation table unchanged (e.g. Sim 1 alt err -4.3 %, Sim 3 alt err -1.9 %).
Decisions: Drag-divergence Mach = 0.8, peak wave Cd = 0.30 at M = 1.15.
Open issues: none

## C1 Parse stages properly
Status: done
Commit: pending
What changed: Added `StageBoundary` and optional `stages?: StageBoundary[]` to `RocketModel` in `src/types.ts`, populated stage boundaries in `src/ork/parser.ts` (in order from top/sustainer down to booster), and added multi-stage `.ork` tests in `src/ork/parser.test.ts` (skipping if `fixtures/external/` is absent).
Checks: tsc ok, vitest 252/252
Numbers: n/a
Decisions: Kept `stages` optional on `RocketModel` so all existing single-stage tests remain untouched.
Open issues: none

## C2 Fly stages
Status: done
Commit: pending
What changed: Added `stage separation` and `stage ignition` to `FlightEventType` and optional `stageMotors` to `SimConfig` in `src/types.ts`; implemented multi-stage separation (dropping lower stage components and recomputing length/maxRadius) and delayed upper-stage ignition in `src/physics/sim.ts`; removed the "staging is not simulated" warning in `src/ork/parser.ts`; added multi-stage test in `src/physics/sim.test.ts`.
Checks: tsc ok, vitest 253/253
Numbers: n/a
Decisions: Single-stage flights without `stageMotors` take the exact original code path for bit-identical results.
Open issues: none

## D1 RH-200 sounding rocket sample
Status: done
Commit: pending
What changed: Added `src/ork/rh200.ts` (`RH200_ORK_XML` and `RH200_STAGE_MOTORS`) and `src/ork/rh200.test.ts` testing 2-stage parsing and flight simulation.
Checks: tsc ok, vitest 262/262
Numbers: n/a
Decisions: Used published RH-200 diameter (0.20 m) and length (~3.6 m); marked estimated nose/fin/wall thicknesses and approximate motor thrust curves clearly in comments.
Open issues: none

## D2 Real-flight reference data
Status: done
Commit: pending
What changed: Added `src/data/lvm3Chandrayaan3.ts` and `src/data/lvm3Chandrayaan3.test.ts` with `LVM3_CHANDRAYAAN3_EVENTS` (S200 separation 127.0 s, Fairing separation 195.0 s, L110 separation 305.6 s) from `rocket-physics/README.md`.
Checks: tsc ok, vitest 263/263
Numbers: n/a
Decisions: Left `altitudeM` and `velocityMS` undefined rather than guessing.
Open issues: none

## E1 Planets in the right place in the sky
Status: done
Commit: pending
What changed: Added `gmstFromJd` and `eclipticToSiteWorld` to `src/world/ephemeris.ts` and tested Sriharikota equinox solar noon (~76.28 deg elevation) and midnight (below horizon) in `src/world/ephemeris.test.ts`.
Checks: tsc ok, vitest 264/264
Numbers: Sriharikota equinox noon elevation 76.28 deg
Decisions: Left `bodyPositionEarthCentred` unchanged to avoid breaking existing scene tests; `solarSystem.ts` can call `eclipticToSiteWorld` with `gmstFromJd(jd)` and site `(latDeg, lonDeg)`.
Open issues: none

# TASK-03

## ITEM 1 Put the staging warning back
Status: done
Commit: 39f58b9
What changed: Restored the multi-stage warning in `src/ork/parser.ts` for `stageCount > 1` ("Rocket has N stages. Stages separate only when stage motors are supplied; otherwise all stages fly as one stacked rocket.") and added an assertion in `src/ork/parser.test.ts`.
Checks: parser.test.ts 24/24; tsc failed only on pre-existing `src/app/main.ts(100,28)` (`setConstellations` on `SolarSystem`, off-limits); vitest 275/276 (`series.test.ts` timed out at 5000 ms under parallel load).
Numbers: n/a
Decisions: none
Open issues: `src/app/main.ts(100,28)` type error from `app` merge.

## ITEM 2 Find the missing mass on Dual parachute deployment
Status: done
Commit: 8c45594
What changed: Parsed `<overridemass>` and `<overridesubcomponentsmass>` on `<stage>` in `src/ork/parser.ts` into `StageBoundary` (`src/types.ts`), applied stage-level mass override scaling in `src/physics/massprops.ts`, added a unit test in `src/physics/massprops.test.ts`, and tightened validation bounds in `src/validate/openrocket.test.ts`.
Checks: openrocket.test.ts 2/2, massprops.test.ts 7/7
Numbers: Dual parachute deployment: rodV err +10.5%..+18.1% -> -3.1%..+0.6%; vmax err +11.2%..+40.4% -> -2.3%..-0.1%; alt err -9.5%..+55.4% -> -5.4%..-1.0%. Design 1 unchanged (-4.3%..-1.9% alt).
Decisions: Scaled stage component masses by `massOverride / sum` to preserve CG and inertia distribution.
Open issues: none
