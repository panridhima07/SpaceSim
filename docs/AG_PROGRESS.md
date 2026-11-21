# Antigravity progress

## A1 Separation motion
Status: done
Commit: pending
What changed: Added `src/render/launcherStaging.ts` and `src/render/launcherStaging.test.ts` with `updateLauncherStaging` to animate separated boosters (radial drift, fallback, tilt), core stages (vertical fallback), and fairing halves (sideways swing + tilt), hiding parts at >= 8 s and restoring initial positions when `null`.
Checks: tsc ok, vitest 235/235
Numbers: n/a
Decisions: Used simple kinematic drift/tilt curves; `HIDE_AFTER_S = 8`.
Open issues: none
