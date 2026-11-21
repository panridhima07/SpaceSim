# Physics 02 — failures with consequences, state at any time, predicted path

Paste everything below the line into Gemini 4 Neon (medium), started in `C:\Users\medha\Desktop\Hackathons\Astra` on branch `app`.

Run this only after `docs\prompts\PHYSICS-01-pressure-thermal-faults.md` has been executed. The expected numbers below were measured on 22 Nov 2026 by flying LVM3-M4 with prototypes of these mechanisms.

---

You are continuing work on Astra, a hackathon project: a TypeScript + Three.js + Vite web app (Capacitor for Android) that designs and flies rockets in 3D. The previous session added a passive fault monitor to the orbital engine. It can say "this limit was crossed", but nothing happens when it is, nothing can be made to fail on purpose, and the recorded flight can only be read at its stored samples. This session closes those three gaps:

1. **State at any time** — ask a recorded flight for everything known at time `t`.
2. **How close to failure, continuously** — a health value for every monitored system at every sample, not only a flag when a limit is crossed.
3. **Failures that change the flight** — inject a failure, let the vehicle and guidance respond, and classify how the mission ended.
4. **Predicted path** — where the vehicle would come down if thrust stopped now, and the coast path ahead of any instant.

## Before you start

Read, in this order: `docs\SYSTEM_DESIGN.md`, `docs\PHYSICS-PROGRESS.md` (what the last session actually built and measured), `rocket-physics\src\faults\` (all files), `rocket-physics\src\sim\simulation.ts`, `rocket-physics\src\gnc\autopilot.ts` (the options and the sequencer), `rocket-physics\src\orbit\propagate.ts`, and everything in `src\mission\`.

Precondition check:

```powershell
npm run typecheck
npm test
cd rocket-physics; npm test; cd ..
```

All three must be green, and `rocket-physics\src\faults\monitor.ts` must exist and export `FaultMonitor` and `monitored`. If not, write what you found in `docs\PHYSICS-PROGRESS.md` under a `# PHYSICS-02` heading and stop. Record the baseline test counts.

Where a name in this prompt differs from what the previous session actually wrote, the code wins: adapt, and note the difference in the progress file.

## Rules

- Work in the order A to E. After each part run its checks; commit when green. If a check still fails after two attempts at a fix, stop, record the command, the last 30 lines of output and what you tried, commit the progress file, and end. Never delete, skip or loosen an existing test. Never change an expected number in this prompt to make a test pass; if your result is outside a band, the implementation is wrong or the band is, and in the second case you stop and report it.
- PowerShell on Windows, Node v26.
- Commits are local only; never push. Stage files by name. Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git restore`, `git checkout -- <file>` or `git reset`: other people have uncommitted work in this tree. One-line commit messages, with no mention of any AI tool and no `Co-Authored-By` line, in commits or files.
- `rocket-physics\` stays dependency-free and runnable on plain Node: erasable TypeScript only, `.ts` import extensions, `import type` for types.
- Do not edit `rocket-physics\src\sim\simulation.ts` or `rocket-physics\src\gnc\`. Everything here is done from outside the integrator, through the `FlightComputer` hook and public `Simulation` members. Do not edit `src\app\`, `src\builder\`, `src\render\` or `src\physics\`.
- A flight with no failures and `destructive` off must be bit-for-bit the flight it was before this session. Prove it with a test (final orbit elements and sample count equal to a plain run).
- A full LVM3 flight costs 4 to 10 s of CPU. Fly each distinct case once per test file at module level and share the result. Keep the added test time under about 90 s.
- Append to `docs\PHYSICS-PROGRESS.md` after each part: status, commit hash, what changed, test counts, every measured number asked for.

---

## Part A — a richer sample and `snapshotAt`

**A1. Sample fields.** Extend `FlightSample` in `src\mission\record.ts` with optional fields and fill them in `toSample` (`src\mission\adapter.ts`) and `flyMission`: `latDeg`, `lonDeg`, `downrange` (m), `verticalSpeed`, `pitchDeg`, `alphaDeg`, `apoapsis`, `periapsis` (m above the equatorial radius), `dvExpended` (m/s), `phase` (the autopilot's phase string), `propellant` (kg remaining per vehicle stage, summed over that stage's tanks, 0 once the stage is gone). `sim.telemetry()` already has most of these.

Also put on `FlightRecord`: `epochJD` and `liftoffSimTime` (the simulation time of liftoff), which Part D needs.

**A2. `src\mission\snapshot.ts`.**

```ts
export interface FlightSnapshot extends FlightSample {
  lastEvent: { label: string; t: number } | null;      // latest marker of kind 'event' at or before t
  nextEvent: { label: string; t: number; in: number } | null;
  activeFaults: FlightFault[];                         // faults whose [tFirst, tLast] contains t (Part B adds the interval)
  worstHealth: { key: string; value: number } | null;  // Part B
  iip: { latDeg: number; lonDeg: number } | null;      // Part D, nearest entry within 10 s
}
export function snapshotAt(record: FlightRecord, t: number): FlightSnapshot
```

Bracket `t` by binary search. Numbers interpolate linearly; `pos` and `vel` component-wise; `quat` by shortest-path slerp, returned normalised; arrays (`stageThrottle`, `propellant`) element-wise; `health` key by key. Discrete fields (`stage`, `phase`) come from the earlier sample. `t` before the first sample returns the first; after the last returns the last. An empty record throws a clear error. The function must not mutate the record and must be fast enough to call every frame (no allocation proportional to the record length).

Tests (`src\mission\snapshot.test.ts`, one nominal flight):

- At an exact sample time the snapshot equals that sample field for field.
- Halfway between two samples `altitude` is the mean of the two and `|quat|` is 1 within 1e-9.
- `snapshotAt(record, 57.3).q` is between 38 000 and 45 000 Pa (max-Q; prototype 41 436 at 57.3 s).
- `snapshotAt(record, 400)`: `stage` is 2, `phase` is `'closedLoop'`, `propellant[0]` is 0, `nextEvent.label` mentions the C25 cutoff, and `nextEvent.in` is between 500 and 570.
- `snapshotAt(record, -5)` and `snapshotAt(record, 1e9)` return the first and last samples.
- `latDeg` at `t = 0` is within 0.05 of 13.72 and `lonDeg` within 0.05 of 80.23 (Sriharikota).

## Part B — continuous health

In `rocket-physics\src\faults\monitor.ts`:

**B1. Fault intervals.** Give `Fault` two more fields, `tFirst` and `tLast`: the first and the last mission time the condition was in violation at any severity. One-shot faults (jettison, separation, the static chamber check) have `tFirst === tLast`. Mirror them on `FlightFault` in `record.ts`.

**B2. Health.** Add `health: Record<string, number>` to the monitor, refreshed on every `observe`. Each value is a utilisation: 0 is unloaded and **1.0 is exactly the critical limit of the matching fault**, so the health value and the fault can never disagree. Use the same quantities the checks already compute:

| key | value |
|---|---|
| `maxQ` | `q / limits.maxQ` |
| `qAlpha` | `q * |alpha| / limits.maxQAlpha`, 0 when `q <= 1000` |
| `axialG` | `accelG / (1.25 * limits.maxG)` |
| `skin` | `(skinTemp - ambientTemp) / (maxTemp - ambientTemp)` |
| `fairingDp` | `deltaP / maxDeltaP`, 0 without a fairing |
| `depressRate` | `rate / maxDepressRate` |
| `tankBurst` | max over attached liquid tanks of `1.1 / fos` |
| `caseBurst` | max over burning solids of `1.1 / fos`, else 0 |
| `tankBuckling` | max over core liquid tanks of `max(0, util)` |
| `cavitation` | max over tanks of burning stages of `npshRequired / (ullage + head - vapourPressure)`; 2 if the denominator is `<= 0`; 0 if nothing is burning |
| `nozzle` | max over burning stages with `thr >= 0.5` of `0.25 * ambientPressure / exitPressure`, else 0 |
| `payloadHeat` | after fairing jettison and below 200 km: `fmHeatFlux / (2 * limits.payloadHeatFlux)`, else 0 |

Also `worst(): { key: string; value: number }` and `peaks(): { key: string; value: number; t: number }[]` (the highest value each key reached and when).

**B3. Record.** `flyMission` copies `monitor.health` onto each sample as `health`, and puts `healthPeaks` on the record.

Tests:

- Nominal flight: every health value on every sample is finite, `>= 0` and `< 1`.
- Nominal peaks (prototype values in brackets): `maxQ` 0.69 to 0.82 (0.75) at 50 to 65 s; `axialG` 0.62 to 0.75 (0.69); `skin` 0.55 to 0.87 (0.71); `fairingDp` 0.14 to 0.32 (0.22); `tankBurst` 0.60 to 0.74 (0.67); `cavitation` 0.42 to 0.62 (0.52).
- Scenario `thin-nose`: the `skin` peak is above 1, and the first sample where `health.skin > 1` is within 1 s of the `skin-temp` fault's first critical moment.
- For every fault in every flown record, `tFirst <= t <= tLast`.

Record the full nominal peaks table in the progress file.

## Part C — failures that change the flight

**C1. `rocket-physics\src\faults\inject.ts`.**

```ts
export type Failure =
  | { kind: 'engine-out'; stage: number; at: number; engines: number }   // lose this many engines of the stage
  | { kind: 'stage-shutdown'; stage: number; at: number }
  | { kind: 'gimbal-lock'; at: number; stage?: number }                  // all stages if omitted
  | { kind: 'leak'; stage: number; tank: number; at: number; rate: number }  // kg/s from `at` onward
  | { kind: 'fairing-stuck' };
// `at` is seconds after liftoff.
export class FailureInjector {
  constructor(failures: Failure[]);
  apply(sim: Simulation): void;                      // call once per step, before the autopilot
  ascentOverrides(): Partial<AscentOptions>;         // { fairingHeatFlux: -1 } when fairing-stuck is present
}
```

How each one is done with public members only (all prototyped and working):

- `stage-shutdown`: `st = sim.rt.stages[i]; st.burnedOut = true; st.burnoutTime = sim.t; sim.shutdown(i, 'failure');`. Marking it burned out stops the autopilot from relighting it and lets the sequencer stage past it. Solids cannot be shut down; for a solid, do nothing and emit a `warning` event.
- `engine-out`: reduce `sim.vehicle.stages[i].engineCount` and emit `sim.event('failure', ...)`. Thrust and propellant flow both follow `engineCount`. If it reaches 0, do a `stage-shutdown` instead.
- `gimbal-lock`: set `engine.maxGimbal = 0` on the affected stages and emit a `failure` event.
- `leak`: each call after `at`, subtract `rate * dt` from `sim.prop[tankOffsets(vehicle)[stage] + tank]`, floored at 0. Emit one `failure` event when it starts.
- `fairing-stuck`: nothing at run time; the caller merges `ascentOverrides()` into the autopilot options so the jettison condition can never be true.

These mutate the `VehicleSpec`. That is safe only because every flight builds a fresh one (`MissionDef.vehicle()`); say so in a comment and never share a spec between flights.

**C2. Consequences.** Add to `monitor.ts` a way to read faults that have just become critical (for example `drainNewCriticals(): Fault[]`). Then in `inject.ts`:

```ts
export function supervised(inner: FlightComputer, parts: { monitor?: FaultMonitor; injector?: FailureInjector; destructive?: boolean }): FlightComputer
```

Each `update`: `injector.apply(sim)`, then `monitor.observe(sim)`, then consequences if `destructive`, then `inner.update(sim)`. Keep `monitored` working (it can call `supervised`).

Consequences when `destructive` is true, after liftoff only:

| trigger | effect |
|---|---|
| a new critical fault whose id starts with `tank-burst`, `case-burst`, `tank-buckling`, `max-q`, `q-alpha` or `fairing-dp` | `sim.event('breakup', <fault title>)`, then `sim.ended = true` |
| a critical `chamber-overpressure:i` (found before liftoff) | the same breakup, 3 s after liftoff |
| a new critical `cavitation:i:k` | `stage-shutdown` of stage `i`, once |
| `sim.diag.q > 5000` and `|sim.diag.alpha| > 30°` | breakup with the message "Aerodynamic breakup: lost attitude control at high dynamic pressure" |

In `src\mission\adapter.ts` make `toMarkers` treat event types `failure` and `breakup` as `critical`.

**C3. Outcome.** `rocket-physics\src\faults\outcome.ts`:

```ts
export type Outcome = 'nominal' | 'degraded-orbit' | 'suborbital' | 'impact' | 'breakup' | 'pad-abort';
export interface OutcomeReport {
  outcome: Outcome;
  summary: string;                      // one plain sentence with the numbers
  perigeeAltitude: number; apogeeAltitude: number;
  apogeeShortfall: number;              // target apogee minus achieved, m; 0 when nominal
  impact: { latDeg: number; lonDeg: number; t: number } | null;   // where it comes down, for suborbital and breakup
}
export function classifyOutcome(sim: Simulation, autopilot: AscentAutopilot): OutcomeReport
```

Order of tests: never lifted off → `pad-abort`; a `breakup` event → `breakup`; an `impact` event → `impact`; `autopilot.reachedTarget` → `nominal`; perigee altitude at least 120 km → `degraded-orbit`; otherwise `suborbital`. For `suborbital` and `breakup`, compute `impact` with `propagateToImpact` from the final state (no drag term, the simulation's `epochJD` and gravity options, a 2-hour limit).

Export the new modules from `rocket-physics\src\index.ts`.

**C4. Mission wiring.** `FlyOptions` gains `failures?: Failure[]`, `failureCase?: string` and `destructive?: boolean`. `FlightRecord` gains `outcome?: OutcomeReport` and `failureCase?: string`. `flyMission` builds the injector, merges its ascent overrides, and uses `supervised`. `MissionDef` gains `failureCases`, and `lvm3-m4` gets:

| id | failures | `note` text |
|---|---|---|
| `vikas-out` | `engine-out`, stage 0, at 200, engines 1 | One of the two Vikas engines shuts down in flight. |
| `l110-shutdown` | `stage-shutdown`, stage 0, at 200 | The liquid core stage shuts down early. |
| `c25-shutdown` | `stage-shutdown`, stage 2, at 600 | The cryogenic stage shuts down early. Comparable in kind to GSLV-F10 (2021), where the cryogenic stage failed. |
| `fairing-stuck` | `fairing-stuck` | The payload fairing does not separate. Comparable in kind to PSLV-C39 (2017). |
| `gimbal-lock` | `gimbal-lock`, at 40 | Thrust-vector control freezes just before max-Q. |
| `lh2-leak` | `leak`, stage 2, tank 1, at 320, rate 2 | The hydrogen tank leaks 2 kg/s. |

The historical comparisons are different vehicles; keep the wording "comparable in kind" and do not claim the simulation reproduces those flights.

Tests. Library level (`rocket-physics\test\inject.test.ts`) or app level (`src\mission\fly.test.ts`), your choice, but fly each case once. Prototype results in brackets.

| case | expected |
|---|---|
| no failures, `destructive: true`, nominal spec | `nominal`; orbit and sample count identical to a plain run |
| `vikas-out` | `nominal` — the mission is saved; C25 cutoff between 1040 and 1085 s [1061]; L110 burnout between 395 and 430 s [412] |
| `l110-shutdown` | `suborbital`; apogee 150 to 190 km [170]; perigee negative; an `impact` point with longitude east of 85° |
| `c25-shutdown` | `suborbital`; apogee 270 to 320 km [296] |
| `fairing-stuck` | `degraded-orbit`; perigee 160 to 180 km [170]; apogee 20 000 to 30 000 km [24 966]; no `fairing` event |
| `gimbal-lock`, `destructive: false` | `impact` between 120 and 180 s [147] |
| `gimbal-lock`, `destructive: true` | `breakup` before 120 s |
| scenario `blocked-vent`, `destructive: true` | `breakup` between 20 and 90 s, caused by `fairing-dp` |
| scenario `regulator-low`, `destructive: true` | `breakup` before 108 s (the under-pressurised core tank buckles before the core even lights) |
| scenario `hot-grain`, `destructive: true` | `breakup` between 2 and 5 s |
| `lh2-leak` | do not fly it to the end (17 s of CPU). Step a simulation to 340 s after liftoff with and without the leak and assert the LH2 mass differs by 40 kg within 5 kg |

For every flown record assert `outcome.summary` is non-empty and `JSON.stringify(record)` round-trips. Record each case's outcome, final orbit and end time in the progress file.

## Part D — predicted path

**D1. Instantaneous impact point.** In `flyMission`, every 10 s of mission time while the osculating perigee altitude is below 100 km, call `propagateToImpact(sim.r, sim.v, sim.t, { epochJD: sim.epochJD, gravity: sim.cfg.gravity }, sim.t + 7200)` and, when it returns a hit, push `{ t, latDeg, lonDeg }` onto `record.iipTrack`. This is where the vehicle would come down if thrust stopped at that instant; 76 calls cost about 0.2 s in the prototype. Feed `snapshotAt`'s `iip` field from it.

Tests, nominal flight: between 60 and 90 entries [76]; the first is within 0.1° of the pad (13.72, 80.23); the entry nearest 125 s has longitude 82.7 to 84.7 [83.70] and latitude 13.4 to 13.9 [13.67]; longitude never decreases along the track; the last entry is before 800 s [the point leaves the Earth at about 780 s]; `snapshotAt(record, 900).iip` is `null`.

**D2. Coast path ahead.** `src\mission\predict.ts`:

```ts
export function coastPath(record: FlightRecord, t: number, horizon: number, step = 10): { t: number; pos: Vec3; altitude: number }[]
```

Take `snapshotAt(record, t)`, convert `pos` and `vel` back with `appToEci`, and integrate with the library's `propagate` (gravity only, `record.epochJD`, simulation time `record.liftoffSimTime + t`), collecting a point every `step` seconds until `horizon` or until the altitude reaches 0. Return positions in the app frame and mission time. Export what you need through `src\mission\engine.ts`.

Tests: `coastPath(nominal, 600, 3000)` ends at the ground and its highest altitude is 270 to 320 km — the same answer as the `c25-shutdown` flight, reached by a different route, which is the cross-check that the frames and times are right. `coastPath(nominal, <last sample t>, 3000)` never drops below 160 km. The first point equals the snapshot position within 1 m.

## Part E — worker and contract

- `src\mission\worker.ts` and `client.ts` currently forward only `sampleInterval`. Forward the whole `FlyOptions` (`scenario`, `failures`, `failureCase`, `destructive`). Extend `client.test.ts` to show a failure case survives the in-thread fallback path.
- Update the contract block in `docs\SYSTEM_DESIGN.md` with every field this session added.
- Final checks: `npm run typecheck`, `npm test`, `npm run build`, and `npm test` inside `rocket-physics\`.

## Finish

Append a `# PHYSICS-02 summary` to `docs\PHYSICS-PROGRESS.md`: final test counts and added test time; the nominal health-peak table; the outcome table for every failure case; the size of a nominal record as JSON in kilobytes; every place this prompt did not match the code; anything not done. Commit. Do not push.

## Not in this session

Monte Carlo dispersions and wind; tuning the model to the real LVM3-M4 event times; other vehicles; moving design mode onto `FlightRecord`; a range-safety corridor with automatic destruct; stage-separation failure; thrust that varies with grain temperature; propellant settling at upper-stage ignition; engine cooling, base heating, pogo; any UI.
