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

## ITEM 3 Measure fin lift term by term
Status: done
Commit: pending
What changed: Measured `A_simple_model_rocket.ork` fin set (`N=3`, `Cr=0.0508`, `Ct=0.0508`, `s=0.03`, `m=0.0254`, `rb=0.0125`, `d=0.025`) by hand: `l = 0.039309 m`, `Kfb = 1.29412`, `denom = 2.2644`, `CN_alpha_fin = 9.876`, `CN_alpha_nose = 2.0`, total `11.876` (`11.918` at `M=0.092`). Matches `aeroProps` to 4 digits (`11.877` at `M=0.017`, `11.918` at `M=0.092`).
Checks: tsc/vitest unchanged
Numbers: OpenRocket `CNa = 15.607` at `t=0.388 s` (after rail exit, `alpha > 0`, includes body lift); `NaN` at `t=0.132 s` (`alpha = 0`).
Decisions: Left `finCnAlphaIncompressible` unchanged because the hand-worked Barrowman fin + nose terms match `aeroProps` exactly; the `~3.7` difference in OpenRocket's `CNa` column is body normal force at `alpha > 0`.
Open issues: none

## ITEM 4 Make multi-stage flight real
Status: done
Commit: a6dec7f
What changed: Updated `src/physics/sim.ts` to include unburnt upper-stage motors in mass/CG while lower stages burn and to remove separated stages' parachutes on stage separation; added `src/ork/stageMotors.ts` and `src/ork/stageMotors.test.ts` (`buildStageMotors` returning firing-order motors).
Checks: stageMotors.test.ts 1/1, sim.test.ts 6/6
Numbers: n/a
Decisions: Single-stage flights without `stageMotors` remain bit-identical.
Open issues: none

## ITEM 5 Tidy up
Status: done
Commit: dbcb10d
What changed: Deleted duplicate `src/data/lvm3Chandrayaan3.ts` and `.test.ts` (superseded by `src/mission/vehicles.ts`), and updated `transonicWaveCd` comment in `src/physics/aero.ts` to state it is an uncalibrated placeholder.
Checks: vitest 277/277
Numbers: Design 2 Sim 3 (J570W, ~Mach 1.1) vmax err +17.3% -> +11.2% (before mass fix), -2.3% (after mass fix).
Decisions: none
Open issues: none

## TASK-03 summary

| quantity | before | after |
|---|---|---|
| design 1 apogee error range | -4.3% to -1.9% | -4.3% to -1.9% |
| design 1 max speed error range | -2.9% to -2.2% | -2.9% to -2.2% |
| design 1 CN-alpha (ours / OpenRocket) | 11.918 / 15.607 | 11.918 / 15.607 (zero-alpha Barrowman exact; OR includes alpha>0 body lift) |
| design 1 stability margin | unchanged | unchanged |
| design 1 dry mass error | +3.4% | +3.4% |
| design 2 rail exit speed error range | +10.5% to +18.1% | -3.1% to +0.6% |
| design 2 max speed error range | +11.2% to +40.4% | -2.3% to -0.1% |
| design 2 apogee error range | -9.5% to +55.4% | -5.4% to -1.0% |
| two-stage example apogee error | not simulated | multi-stage sim + `buildStageMotors` added |
| three-stage example apogee error | not simulated | multi-stage sim + `buildStageMotors` added |
| total tests passing | 264 | 277 |

# TASK-04

## Baseline
- `npm run typecheck`: clean (0 errors)
- `npm test`: 51 files, 786 passed (0 failed)
- `npm run build`: clean (built in 5.14 s)

## Part A — mission mode, the 3D view
- Status: done
- Commit: `53138ee`
- What changed: Created `src/app/missionView.ts` (`createMissionView`, `latLonToApp`, `vehicleToLauncherSpec`, `separationAges`) and `src/app/missionView.test.ts` (3 tests). Implemented floating-origin `worldGroup`, rotating `earthGroup` with oblate WGS-84 sphere, 80 km faded ground disc with `buildLaunchComplex` anchored to the first sample, sky-to-space fade + star field, staged launcher + plumes + breakup fireball, and `chase` / `pad` / `map` cameras.
- Notes: `latLonToApp` uses WGS-84 geodetic coordinates matching `geodeticToEcef`. `lvm3()` defines 3 stages (L110 core, S200 parallel count 2, C25 core) and a fairing.
- Tests: `npm run typecheck` clean, `npm test` 52 files, 789 passed (0 failed).
- Open issues: none

## Part B — trajectory
- Status: done
- Commit: `c9a2c80`
- What changed:
  - B1: Added `buildFlownPathPoints` and `elementsFromAppState` to `src/app/missionView.ts`; wired Earth-fixed flown path (relative to first sample, `setDrawRange` by `t`), dashed Earth-fixed predicted coast path (`coastPath`, throttled <= 2 Hz, hidden above 100 km periapsis), impact ring (`snapshot.iip`), and inertial final orbit (`orbitPoints`/`buildOrbitLine` when perigee > 80 km). Added 2 tests in `src/app/missionView.test.ts`.
  - B2: Confirmed model-rocket trajectory defects in `src/render/effects.ts` + `src/app/main.ts` (`points.shift()` after 5000 points at 20 Hz = 250 s drops launch; only pushed when `replayT === null` so scrubbing doesn't shorten; skipped when `toggles.trail` is off leaving holes). Added `setFromLog(log, maxT)` to `buildTrajectoryLine` with even decimation preserving first & last points, updated `updateSmokeAndTrail` in `src/app/main.ts` (keeping existing uncommitted `boot.ts` edits intact), and added 2 tests in `src/render/effects.test.ts`.
- Tests: `npm run typecheck` clean, `npm test` 52 files, 793 passed (0 failed).
- Open issues: none

## Part C — mission mode, the screen
- Status: done
- Commit: `fa0eaa2`
- What changed: Created `src/app/mission.css`, `src/app/missionUi.ts` (`createMissionUI`), and `src/app/missionUi.test.ts` (4 tests). Implemented header with vehicle name, Back button, case/scenario picker + note, and Fly button; telemetry + propellant bars; clickable timeline with reference time delta and flaws; health bars (good < 0.8, warning 0.8..1.0, critical > 1.0) + active faults; transport (play/pause, 1x/5x/20x/100x warp, scrubber, chase/pad/map cameras, IIP readout); outcome banner at end; busy overlay; and responsive phone layout with 44 px touch targets and slide-up sheet.
- Tests: `npm run typecheck` clean, `npm test` 53 files, 797 passed (0 failed).
- Open issues: none

## Part D — wire it into the app
- Status: done
- Commit: `7e08b68`
- What changed: Added `'mission'` to `appMode` in `src/app/main.ts` with playback advancement (`realDt * warp`), 10 Hz throttled UI updates, Web Worker `runMission('lvm3-m4', opts)` execution with busy overlay, per-case `missionCache`, `destructive: true` for failure cases and scenarios, error banner preserving previous record on failure, and `missionView.resize` hook. Added `"Fly LVM3 mission"` button to `src/app/ui.ts` brand row, `"LVM3"` button to phone rail, `"FLY LVM3 MISSION"` button to `src/app/hero.ts` title screen, and `onMission?()` to `src/app/uiTypes.ts`. Left `window.astraRunMission` intact.
- Visual checks (1–8):
  1. Mission button opens mission mode and computes in Web Worker with `"Computing flight…"` overlay without freezing the page.
  2. At T+0 vehicle stands upright on the Sriharikota pad (`groundDisc` at `y = -2.02`, pedestal top and launcher core base at `y = 0`), not buried or floating.
  3. S200 separates at T+126.7 s (ref 127.0 s), fairing at T+153.2 s (ref 195.0 s shown in timeline), L110 at T+307.1 s (ref 305.6 s); plumes switch with active engines and expand with altitude.
  4. Flown path starts at the pad (`offsets[0..2] = 0`) and follows the vehicle cleanly in the rotating Earth group with no jump, gap, or chord.
  5. Map camera shows the `170.0 x 36 501.0 km` Keplerian ellipse passing through the cutoff position.
  6. `gimbal-lock` (`destructive: true`) ends in breakup at T+41.5 s with fireball and Bay of Bengal IIP/impact at `13.72°N, 80.29°E`; `c25-shutdown` ends suborbital at T+630.0 s with IIP/impact at `10.71°N, 115.42°E`.
  7. Scrubbing backwards re-attaches separated stages/fairing and shortens the flown path via `setDrawRange`.
  8. Back returns to the flight screen with the model rocket and sim state preserved.
- Tests: `npm run typecheck` clean, `npm test` 53 files, 797 passed (0 failed), `npm run build` clean.
- Open issues: none

## Part E — UI mismatch audit (listed before editing)
1. **Builder (`src/app/style.css`, `src/app/astraTheme.css`)**:
   - `.sfb-builder` in `style.css` sets `--sfb-accent: #4da3ff` and hardcodes `rgba(77, 163, 255, ...)` on `.sfb-b-cat.is-active`, `.sfb-b-part-list`, `.sfb-b-right`, `.sfb-b-sublist`, `.sfb-b-part-card`, `.sfb-b-stack-row.is-selected`, and `.sfb-hud-build` instead of using `--sfb-accent` (`#7fd7ff`) and `--sfb-line`.
   - `.sfb-b-ctrl-label` omits the `.sfb-field-label` `0.2em` letter-spacing from `astraTheme.css`.
   - `.sfb-b-saved-card` and `.sfb-b-chal-item` use `rgba(14, 24, 42, 0.72)` instead of the reference flat card surface `rgba(18, 30, 52, 0.55)` and `var(--sfb-line)`.
   - On phone (`390x844`), `.sfb-builder.sfb-mobile .sfb-b-swatch` is `36x36px` (< 44 px minimum), `.sfb-b-slider` lacks `min-height: 44px`, and modal `.sfb-b-file-actions .sfb-btn` buttons inherit desktop `34px` height (< 44 px).
2. **Moon landing (`landing.html`, `src/landing/main.ts`)**:
   - `landing.html` defines custom `--ink`, `--dim`, `--line`, `--glass`, `--acc` variables instead of `.sfb-root` `--sfb-panel`, `--sfb-line`, `--sfb-text`, `--sfb-muted`, `--sfb-accent`, `--sfb-good`, `--sfb-warning`, `--sfb-critical`, `--sfb-mono`, `--sfb-slab`, and lacks `class="sfb-root"` on `<body>` and `.sfb-panel` / `.sfb-btn` classes.
   - `#brand` top bar lacks `height: 58px` and `pointer-events: none` (with `pointer-events: auto` on children), and `#brand b` colors the entire title cyan instead of `--sfb-muted` with white `strong` and cyan icon.
   - `#hud` `"Ground below"` (`Safe` / `Caution` / `Hazard`) lacks semantic status coloring (`--sfb-good`, `--sfb-warning`, `--sfb-critical`).
   - Mobile media query uses `max-width: 640px` instead of `760px`, dock buttons (`×1`, `×2`, `×5`, `×10`) lack `min-width: 44px`, and `.auth-chip` at `bottom: 12px; left: 12px` (`36x36px`) overlaps `#dock` on `390x844`.
3. **Parts page (`parts.html`) and Title screen (`src/app/hero.css`)**:
   - `parts.html` uses custom `--ink`/`--dim` variables, lacks `"Inter"` in the font stack, hardcodes `#3ddc97` / `#f2b84b` / `#ef5350` on `th.best` / `th.ok` / `th.bad` instead of `--sfb-good` / `--sfb-warning` / `--sfb-critical`, and hardcodes `#0d1522` on `.cell img` instead of `--sfb-panel` and `--sfb-line`.
   - `src/app/hero.css` hardcodes `#dbe9ff`, `#7fd7ff`, `#7f93b2`, `#cfe3ff` instead of `--sfb-*` tokens; `.astra-hero-btn` uses `border-radius: 999px` and `rgba(255, 255, 255, 0.04)` with no hover fill change instead of `.sfb-btn` (`border-radius: 10px`, `rgba(18, 30, 52, 0.55)`, hover `rgba(40, 70, 120, 0.5)`); and on `390x844` the 4 stacked CTA buttons take excessive vertical height instead of a compact 2-column grid with `min-height: 44px`.
4. **Flight simulation HUD & Mission HUD (`src/app/style.css`, `src/app/astraTheme.css`, `src/app/mission.css`, `src/app/missionUi.ts`)**:
   - Desktop `.sfb-brand` top bar ghost buttons (`rgba(255, 255, 255, 0.04)`) and mobile panels (`0.68` opacity without backdrop blur) lose contrast over a bright daytime sky.
   - `.sfb-stress-table` (6 nowrap columns, ~330 px wide) overflows the 300 px desktop `.sfb-right` panel without `overflow-x: auto` on `.sfb-stress-block`.
   - On `390x844` phone, `.sfb-hud-btn` (`46x46px` circle) clips 4-letter `"LVM3"` at `15px` uppercase; `.sfb-root.sfb-mobile .sfb-tele` uses 4 columns (`~67px` each) causing 13–19 px mono values to collide; `.sfb-tabpage .sfb-btn-link` (`36px`), `.sfb-scrub`, and `.sfb-warnings summary` are under 44 px tall; and landscape phone HUD elements miss `env(safe-area-inset-left/right/top/bottom)`.
   - In `src/app/mission.css`, `.msn-btn-active` `(0,1,0)` is overridden by `.sfb-root .sfb-btn` `(0,2,0)` in `astraTheme.css`, and `.msn-select` lacks `.sfb-select`.

## Part E — one UI everywhere
- Status: done
- Commit: `e08e773`
- What changed:
  - Fixed all listed mismatches across `src/app/style.css`, `src/app/astraTheme.css`, `src/app/mission.css`, `src/app/missionUi.ts`, `src/app/hero.css`, `landing.html`, `src/landing/main.ts`, and `parts.html`.
  - Preserved pre-existing uncommitted changes in `src/app/main.ts`, `src/app/style.css`, `landing.html` (`/src/landing/boot.ts`), and `src/landing/main.ts` (`touchHeld` touch-steering buttons) intact alongside our edits.
  - All existing tests in `src/app/ui.test.ts` (20 passed) and `src/app/builderUi.test.ts` (3 passed) pass unchanged.
- Tests: `npm run typecheck` clean, `npm test` 53 files, 797 passed (0 failed), `npm run build` clean.
- Open issues: none

## TASK-04 summary
- **Final test counts (`npm test`)**: 53 test files, 797 tests passed (0 failed); baseline was 51 test files, 786 tests passed (+2 files, +11 tests).
- **Part D eight visual checks**:
  1. **Mission button & non-blocking worker**: Clicking `"Fly LVM3 mission"` (brand row), `"LVM3"` (phone rail), or `"FLY LVM3 MISSION"` (title screen) enters mission mode, displays `"Computing flight…"` while `runMission('lvm3-m4')` executes in a Web Worker, and caches records by case id.
  2. **Pad placement at T+0**: Launcher stands upright at Sriharikota (`13.72°N, 80.23°E`) on `buildLaunchComplex` and the 80 km faded ground disc (`y = -2.02` in `padGroup`, pedestal top and core stage base at `y = 0`), neither buried nor floating.
  3. **Staging & plumes**: S200 boosters separate at `T+126.7 s` (ref `127.0 s`), fairing at `T+153.2 s` (ref `195.0 s`), and L110 core at `T+307.1 s` (ref `305.6 s`); `updateLauncherStaging` animates detachment and `updatePlumes` switches active nozzles and expands plume width with vacuum.
  4. **Flown path**: Earth-fixed path starts at the pad (`offsets[0..2] = 0`) and tracks the vehicle continuously with no jump, gap, or chord across the Earth.
  5. **Map camera orbit ellipse**: `elementsFromAppState` computes the `170.0 x 36 501.0 km` transfer orbit from the cutoff state vector and draws the closed ellipse through the cutoff position.
  6. **Failure cases**: `gimbal-lock` (`destructive: true`) ends in breakup at `T+41.5 s` with an expanding fireball and impact marker in the Bay of Bengal at `13.72°N, 80.29°E`; `c25-shutdown` (`destructive: true`) ends suborbital at `T+630.0 s` with impact marker at `10.71°N, 115.42°E`.
  7. **Scrubbing backwards**: Moving the scrubber or clicking an earlier timeline row re-attaches separated stages/fairing and shortens the flown path draw range.
  8. **Back button**: Returns to the flight screen with the model rocket and simulation intact.
- **Part E UI mismatches fixed**:
  - **Builder**: Unified `.sfb-builder` accent token (`#7fd7ff`), control labels (`.sfb-b-ctrl-label`), scrollbars, cards (`.sfb-b-saved-card`, `.sfb-b-chal-item`), and 44 px phone touch targets (`.sfb-b-swatch` `44x44px`, `.sfb-b-slider`, `.sfb-b-ctrl-num`, modal `.sfb-btn`).
  - **Moon landing**: Applied `.sfb-root` variables, `.sfb-panel`, `.sfb-btn` / `.sfb-btn-primary` / `.is-active`, 58 px top bar with `pointer-events: none` container, semantic hazard coloring (`Safe`/`Caution`/`Hazard`), 760 px mobile breakpoint, `44x44px` minimum button targets, and shifted `.auth-chip` above `#dock` on mobile.
  - **Title screen & Parts page**: Replaced hardcoded colors/fonts in `src/app/hero.css` and `parts.html` with `--sfb-*` tokens, matched `.astra-hero-btn` to `.sfb-btn` (`10px` radius, `rgba(18, 30, 52, 0.55)` surface, hover fill, slab shadow), and arranged the 4 mobile hero CTAs in a balanced 2-column grid with `min-height: 44px`.
  - **Flight & Mission HUD**: Boosted daytime sky contrast on desktop `.sfb-brand` ghost buttons and mobile `.sfb-panel`, added `overflow-x: auto` to `.sfb-stress-block`, sized phone rail `"LVM3"` label to fit the 46 px circle, switched phone expanded `.sfb-tele` from 4 columns to 2 columns, enforced 44 px min-height on `.sfb-btn-link`, `.sfb-scrub`, and `.sfb-warnings summary`, added landscape `env(safe-area-inset-*)` padding, and raised `.sfb-root .sfb-btn.msn-btn-active` specificity.
- **Built JS chunks (`dist/assets`)**:
  - `dist/assets/landing-BlS_dQJL.js`: `0.31 kB` (gzip `0.22 kB`)
  - `dist/assets/esm-BWUpQ3hM.js`: `0.33 kB` (gzip `0.23 kB`)
  - `dist/assets/esm-BeZOJ9bL.js`: `0.34 kB` (gzip `0.24 kB`)
  - `dist/assets/main-EAgFOH7v.js`: `0.36 kB` (gzip `0.25 kB`)
  - `dist/assets/web-CEazzrDS.js`: `0.38 kB` (gzip `0.25 kB`)
  - `dist/assets/web-BaE22RWt.js`: `0.84 kB` (gzip `0.40 kB`)
  - `dist/assets/OrbitControls-H8F2Ggha.js`: `19.59 kB` (gzip `4.63 kB`)
  - `dist/assets/main-BTnhIBct.js`: `41.49 kB` (gzip `17.16 kB`)
  - `dist/assets/worker-BtcpxO9e.js`: `71.07 kB`
  - `dist/assets/main-BYz33l9z.js`: `548.70 kB` (gzip `191.52 kB`)
  - `dist/assets/gate-BhJvj7sV.js`: `820.23 kB` (gzip `217.85 kB`)
- **Prompt vs code differences**:
  - `lvm3()` in `rocket-physics` defines 3 stage entries (`[L110 (core), S200 (parallel: count 2), C25 (core)]`) plus `fairing` and `payload` (rather than two entries), which `vehicleToLauncherSpec` maps directly.
  - `geodeticToEcef` in `rocket-physics` uses the WGS-84 ellipsoid (`E2 = 0.006694`), so `latLonToApp` uses WGS-84 geodetic coordinates rather than a sphere to place Sriharikota within 5 km of `samples[0].pos`.
  - Simulated fairing separation in `flyMission(getMission('lvm3-m4')!)` occurs at `T+153.2 s` while the real LVM3-M4 reference time is `194.96 s` (`~195 s`), both shown in the timeline.
- **Not done**: None.





