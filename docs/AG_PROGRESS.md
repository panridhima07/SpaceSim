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
