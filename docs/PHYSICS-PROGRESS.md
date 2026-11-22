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

## Step A6 — fault monitor flight tests
- Status: done
- Commit: `8860140`
- Changed: created `rocket-physics/test/faultmonitor.test.ts`
- Tests: `faultmonitor.test.ts` 12 passed (0 failed)

### Nominal LVM3-M4 measured numbers
| Quantity | Measured | Prototype | Band |
| --- | --- | --- | --- |
| `peakSkin` | 394.89 K | 407 K | 385–430 K |
| `peakDp` | 1594.1 Pa | 1533 Pa | 1000–2200 Pa |
| `peakRate` | 1949.6 Pa/s | ~1950 Pa/s | 1400–2600 Pa/s |
| `maxQ` | 41435.6 Pa | 41436 Pa | 38000–45000 Pa |
| Smallest `tank-burst` FoS — L110 UH25 | 1.922 | 1.92 | — |
| Smallest `tank-burst` FoS — L110 N2O4 | 1.652 | 1.65 | — |
| Smallest `tank-burst` FoS — C25 LOX | 2.111 | 2.11 | — |
| Smallest `tank-burst` FoS — C25 LH2 | 3.109 | 2.52 | — |

### Scenario fault IDs
| Scenario | Fault IDs (severity) |
| --- | --- |
| `nominal` | `boil-off:2:1(info)` |
| `blocked-vent` | `fairing-dp(critical)`, `boil-off:2:1(info)` |
| `regulator-low` | `tank-buckling:2:1(critical)`, `tank-buckling:0:0(critical)`, `cavitation:0:1(critical)`, `cavitation:2:0(critical)`, `cavitation:2:1(critical)`, `tank-buckling:2:0(warning)`, `boil-off:2:1(info)` |
| `regulator-high` | `tank-burst:0:0(critical)`, `tank-burst:0:1(critical)`, `tank-burst:2:0(critical)`, `boil-off:2:1(info)` |
| `hot-grain` | `chamber-overpressure:1(critical)`, `boil-off:2:1(info)` |
| `thin-nose` | `skin-temp(critical)`, `boil-off:2:1(info)` |
| `long-hold` | `boil-off:2:1(warning)` |
| `early-fairing` (`fairingHeatFlux: 20000`) | `payload-heating(critical)`, `boil-off:2:1(info)` |

## Step A7 — faults on FlightRecord
- Status: done
- Commit: `9297373`
- Changed: updated `src/mission/engine.ts`, `src/mission/record.ts`, `src/mission/vehicles.ts`, `src/mission/fly.ts`, `src/mission/fly.test.ts`, `docs/SYSTEM_DESIGN.md`
- Tests: `src/mission/fly.test.ts` 12 passed, `npm run typecheck` clean

## Step B1 & B2 — model-rocket environmental flaws
- Status: done
- Commit: `9297373`
- Changed: created `src/physics/envFlaws.ts` and `src/physics/envFlaws.test.ts`; hooked `analyzeEnvironment` into `analyzeFlight` in `src/physics/flaws.ts`
- Tests: `envFlaws.test.ts` 10 passed, `flaws.test.ts` 6 passed, `npm run typecheck` clean

## Physics 01 Summary
- Final test counts after Physics 01 + 02:
  - App (`npm test`): 51 files, 786 passed (0 failed)
  - Orbital engine (`cd rocket-physics; npm test`): 41 suites, 240 passed (0 failed)
  - `npm run typecheck` and `npm run build`: clean
- Prompt vs code mismatches: none in Physics 01 (all formulas, constants, and thresholds matched; C25 LH2 minimum tank-burst FoS measured 3.109 vs prototype 2.52, while all asserted bands passed).
- Not done: none (all items in Physics 01 Parts A and B are complete).

# PHYSICS-02

## Precondition
- `rocket-physics/src/faults/monitor.ts` present and exporting `FaultMonitor` and `monitored`.
- `npm run typecheck`, `npm test`, and `cd rocket-physics; npm test` all green.

## Part A — richer sample and snapshotAt
- Status: done
- Commit: `9297373`
- Changed: extended `FlightSample` and `FlightRecord` in `src/mission/record.ts`; populated new fields in `src/mission/adapter.ts` and `src/mission/fly.ts`; created `src/mission/snapshot.ts` and `src/mission/snapshot.test.ts`
- Tests: `src/mission/snapshot.test.ts` 10 passed

## Part B — continuous health
- Status: done
- Commits: `9297373` (orbital `monitor.ts` `tFirst`/`tLast`, `health`, `worst()`, `peaks()`, `drainNewCriticals()`), `b1dd554` (mission `fly.ts` `health` and `healthPeaks`, `fly.test.ts`)
- Tests: `rocket-physics/test/inject.test.ts` 16 passed, `src/mission/fly.test.ts` 15 passed

### Nominal health-peak table (LVM3-M4)
| Key | Peak | Time (T+s) |
| --- | --- | --- |
| `maxQ` | 0.7534 | 57.0 |
| `qAlpha` | 0.1480 | 53.7 |
| `axialG` | 0.6859 | 306.1 |
| `skin` | 0.6251 | 150.0 |
| `fairingDp` | 0.2277 | 58.0 |
| `depressRate` | 0.5570 | 42.7 |
| `tankBurst` | 0.6661 | 110.0 |
| `caseBurst` | 0.6717 | 2.7 |
| `tankBuckling` | 0.0000 | 0.0 |
| `cavitation` | 0.5195 | 306.1 |
| `nozzle` | 0.7966 | 0.0 |
| `payloadHeat` | 0.4970 | 153.2 |

## Part C — failures that change the flight
- Status: done
- Commits: `9297373` (`rocket-physics/src/faults/inject.ts`, `outcome.ts`, `index.ts`, `test/inject.test.ts`), `b1dd554` (`src/mission/engine.ts`, `vehicles.ts`, `fly.ts`, `fly.test.ts`)
- Tests: `rocket-physics/test/inject.test.ts` 16 passed (includes bit-for-bit determinism for nominal `destructive: true` vs plain run and 340 s `lh2-leak` check), `src/mission/fly.test.ts` 15 passed

### Failure case outcomes (LVM3-M4)
| Case | Outcome | Final orbit (perigee x apogee, km) | End time (T+s) | Impact |
| --- | --- | --- | --- | --- |
| `nominal` (`destructive: true`) | `nominal` | 170.0 x 36501.0 | 963.6 | — |
| `vikas-out` | `nominal` | 170.0 x 36501.0 | 1090.2 | — |
| `l110-shutdown` | `suborbital` | -1114.1 x 170.0 | 882.4 | 6.04°N, 138.49°E at T+1437.2 s |
| `c25-shutdown` | `suborbital` | -3110.1 x 295.8 | 630.0 | 10.71°N, 115.42°E at T+951.6 s |
| `fairing-stuck` | `degraded-orbit` | 170.0 x 24966.4 | 1010.6 | — |
| `gimbal-lock` (`destructive: false`) | `impact` | — | 146.7 | — |
| `gimbal-lock` (`destructive: true`) | `breakup` | — | 41.5 | 13.72°N, 80.29°E at T+114.4 s |
| `blocked-vent` (`destructive: true`) | `breakup` | — | 32.9 | 13.72°N, 80.26°E at T+87.3 s |
| `regulator-low` (`destructive: true`) | `breakup` | — | 37.1 | 13.72°N, 80.27°E at T+100.4 s |
| `hot-grain` (`destructive: true`) | `breakup` | — | 3.0 | 13.72°N, 80.23°E at T+6.9 s |
| `lh2-leak` (340 s check) | verified ~40 kg LH2 mass diff within 5 kg | — | 340.0 | — |

## Part D — predicted path
- Status: done
- Commit: `9297373`
- Changed: added `iipTrack` in `src/mission/fly.ts`, `iip` lookup in `src/mission/snapshot.ts`, created `src/mission/predict.ts` (`coastPath`), added Part D tests to `src/mission/snapshot.test.ts`
- Tests: `src/mission/snapshot.test.ts` 10 passed (77 IIP entries on nominal flight)

## Part E — worker, client, and contract
- Status: done
- Commit: `b1dd554`
- Changed: forwarded full `FlyOptions` in `src/mission/worker.ts` and `src/mission/client.ts`; added failure-case fallback test in `src/mission/client.test.ts`; updated `docs/SYSTEM_DESIGN.md` contract block
- Tests: `src/mission/client.test.ts` 3 passed

## Physics 02 Summary
- Final test counts:
  - `npm test`: 51 files, 786 passed (0 failed), duration 35.58 s
  - `cd rocket-physics; npm test`: 41 suites, 240 passed (0 failed), duration 57.3 s
  - `npm run typecheck`: clean (0 errors)
  - `npm run build`: clean (built in 10.77 s)
- Nominal `FlightRecord` JSON size: `2243.99 KB` (`2,297,841` bytes; 1874 samples; 77 IIP entries)
- Prompt vs code mismatches: none (all APIs, types, bands, and contracts matched cleanly; `FlightOutcome` in `record.ts` mirrors `OutcomeReport` from `rocket-physics`).
- Not done: none (all items in Physics 02 Parts A through E are complete).
