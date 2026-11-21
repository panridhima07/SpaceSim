# Physics Progress

## Baseline
- `npm run typecheck`: clean (0 errors)
- `npm test`: 43 files, 349 passed
- `cd rocket-physics; npm test`: 200 passed

## Step A1 — fluids and materials
- Status: done
- Commit: `c7c6b7c`
- Changed: created `rocket-physics/src/faults/fluids.ts`, `rocket-physics/src/faults/materials.ts`, `rocket-physics/test/faults.test.ts`
- Tests: `rocket-physics` 203 passed (0 failed)

## Step A2 — pressure functions
- Status: done
- Commit: `4aa0f0b`
- Changed: created `rocket-physics/src/faults/pressure.ts`, added pressure tests to `rocket-physics/test/faults.test.ts`
- Tests: `faults.test.ts` 7 passed (0 failed)

## Step A3 — thermal functions
- Status: done
- Commit: `b8614e9`
- Changed: created `rocket-physics/src/faults/thermal.ts`, added thermal tests to `rocket-physics/test/faults.test.ts`
- Tests: `faults.test.ts` 10 passed (0 failed)

## Step A4 — fault spec and LVM3 data
- Status: done
- Commit: `c49caec`
- Changed: created `rocket-physics/src/faults/spec.ts`, added spec and scenario tests to `rocket-physics/test/faults.test.ts`
- Tests: `faults.test.ts` 12 passed (0 failed)

## Step A5 — fault monitor
- Status: done
- Commit: `e2fc9c9`
- Changed: created `rocket-physics/src/faults/monitor.ts`, exported all six fault modules from `rocket-physics/src/index.ts`
- Tests: `faults.test.ts` 12 passed, `npm run typecheck` clean
