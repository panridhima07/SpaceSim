## Round 1

- Step 1: created the `app` branch, copied the web app and `rocket-physics/` into the repo, added `space-flight-godot` and `.claude` to `.gitignore`, and copied the design docs.
- Step 1 check: `npm test` passed 211 tests in 20 files, `npm run build` passed, and `rocket-physics` `npm test` passed 200 tests with 0 failures.
- Step 1 note: added `vitest.config.ts` scoping app tests to `src/` so the sibling worktrees and the `rocket-physics` Node tests are not collected.
- Step 2: widened the sample motor mount to a 0.0096 m outer radius with a 0.0005 m wall (18.2 mm inner diameter), and added a parser test that the C6 motor fits.
- Step 2 check: `npm test` passed 212 tests in 20 files.
- Step 2 note: the motor-fit rule is in `src/app/main.ts` (`preflightFlaws`), not `src/physics/flaws.ts`; the old mount was 18 mm inside before floating-point rounding, not 17 mm.
- Step 3: added `allowImportingTsExtensions` to the root `tsconfig.json`, created `src/mission/engine.ts` with re-exports for all requested names, and added `src/mission/engine.test.ts`.
- Step 3 check: `npm run typecheck` passed, `npm test` passed 226 tests in 22 files, and `npm run build` passed.
- Step 3 note: every requested export exists. Untracked `src/render/launcherMesh.ts` and `src/render/launcherMesh.test.ts` appeared in the working tree during this session; they are not part of this round, so they were left untouched and out of the commit (the committed tree has 213 tests in 21 files).
- Step 4: added `src/mission/record.ts` with the `FlightSample`, `FlightMarker` and `FlightRecord` types from the system design, importing `Vec3` and `Quat` from `src/types.ts`.
- Step 4 check: `npm run typecheck` passed.
- Step 5: added `src/mission/adapter.ts` with `eciToApp`, `appToEci`, `attitudeToApp` and `toSample`, plus `src/mission/adapter.test.ts`. Both quaternion types are `[x, y, z, w]` and rotate body vectors into the world; the library nose is body +X and the app nose is body +Y, so `qApp = Cq * q * Bq` with `Cq` a -90 degree X rotation and `Bq` a -90 degree Z rotation.
- Step 5 check: `npm run typecheck` passed and `npm test` passed 218 tests in 22 files.
- Step 5 note: every `FlightSample` field has a source, so none were set to 0. Before liftoff `sim.missionTime` is NaN, so `t` falls back to `sim.t` (pad time); `stage` is the lowest attached core stage. The library uses a WGS-84 ellipsoid, so at Sriharikota `|r|` is about 1.19 km below equatorial `RE` plus site altitude; the sample test therefore compares against the site's local geocentric radius, still within 1 km.
- Step 6 checks: `npm run typecheck` passed; `npm test` passed 218 tests in 22 files; `npm run build` built 58 modules (`dist/assets/index-DIicZwBA.js`, 837.87 kB); `rocket-physics` `npm test` passed 200 tests with 0 failures.

### Done

- Consolidated the web app and `rocket-physics/` into the repository on branch `app`, with `space-flight-godot` and `.claude` ignored.
- Fixed the bundled sample's motor mount so the 18 mm motor fits, with a regression test.
- Wired the app to the physics library through `src/mission/engine.ts` and added the shared `FlightRecord` types.
- Added `src/mission/adapter.ts` (frame conversion, attitude conversion, `toSample`) with tests, and documented the quaternion orders in the file.
- All app and library checks pass from one tree.

### Not done or failed

- None of the six steps failed. Nothing was skipped.

### Things I noticed

- Both quaternion types are `[x, y, z, w]` and rotate body vectors into the world, so the adapter composes them without reordering; only the nose axis differs (library body +X, app body +Y).
- The motor-fit rule lives in `src/app/main.ts` (`preflightFlaws`), not `src/physics/flaws.ts` as Step 2 suggested, and the old mount was 18 mm inside before floating-point rounding rather than 17 mm.
- The library uses a WGS-84 ellipsoid (`RE` is the 6,378,137 m equatorial radius). At Sriharikota `|r|` is about 1.19 km below `RE` plus site altitude, so the Step 5 sample test compares against the site's local geocentric radius to keep the 1 km tolerance meaningful.
- `Simulation.missionTime` is NaN before liftoff, so `toSample` falls back to pad time `sim.t`. `FlightSample.stage` has no direct field; it is the lowest attached core stage.
- `docs/SYSTEM_DESIGN.md` also gives the adapter the job of turning engine events into `FlightMarker`s. Round 1 did not ask for that, so it is left for a later round.
- The untracked `src/render/launcherMesh.ts` and `src/render/launcherMesh.test.ts` noted in Step 3 are no longer in the working tree; the app test count is 218 without them.

## Round 2

- Baseline: `npm run typecheck` passed and `npm test` passed 218 tests in 22 files.
- Step 1: extended `FlightSample` with optional `stageThrottle` and `FlightRecord` with optional `vehicleName`, `stageSeparation`, `fairingSeparation`, `earth` and `reachedTarget`; updated the contract block in `docs/SYSTEM_DESIGN.md` to match.
- Step 1 check: `npm run typecheck` passed.
- Step 2: added an adapter test that checks app body +Z and +X against library body +Z and -Y for the same three quaternions, pinning all three axes.
- Step 2 check: `npm test` passed 219 tests in 22 files.
- Step 3: added `ReferenceEvent` and `toMarkers` to `src/mission/adapter.ts`, mapping event times to liftoff-relative markers, severities, and one-use reference times; added three tests.
- Step 3 check: `npm run typecheck` passed and `npm test` passed 222 tests in 22 files.
