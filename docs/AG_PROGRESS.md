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
