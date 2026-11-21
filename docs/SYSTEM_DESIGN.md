# Astra — system design

Written 21 Nov 2026. This is the target design for the finished project and the list of rounds that get there. Each round is one opencode prompt in `docs/opencode/`.

## What exists today

| Piece | Where it lives now | State |
|---|---|---|
| Space Flight Builder web app (`.ork` import, 3D, 6-DOF model-rocket sim, flaw report, replay, solar system, Android shell) | worktree `space-flight-builder-plan-975db2`, repo root | 211 tests pass, typecheck clean. **Nothing committed.** |
| Orbital launch physics library (`rocket-physics/`: 6-DOF ascent, guidance, staging, orbits, LVM3 / Chandrayaan-3 preset) | worktree `pensive-margulis-f3e2f3` | 200 tests pass. **Nothing committed.** No rendering. |
| Single-file OpenRocket 3D viewer with internal systems (`rocket-viewer/index.html`) | branch `claude/3d-texture-visualization-91ee2f` | Committed on its branch. Separate from the app. |
| Godot project (`space-flight-godot/`) | main checkout, untracked | Abandoned. Not part of the design. |

`main` holds only a README and four name files. The first job is to get the two working codebases into one committed tree.

## The product

One app, two modes, one 3D world.

1. **Design mode** (built). Drop an `.ork` file, see it on the pad at Sriharikota, fly it, read the flaw report, scrub the replay.
2. **Mission mode** (to build). Pick an ISRO vehicle (LVM3 with Chandrayaan-3 first), watch it fly from Sriharikota to orbit in the same 3D world, with an event timeline compared against the real flight of 14 July 2023. This is what ties the project to ASTRA Domain 01 (Indian space missions).

Design mode answers "will my rocket fail?". Mission mode answers "how does a real launch work?". They share the scene, cameras, HUD, time warp and replay.

## Layers

```
            ┌────────────────────────── app (src/app) ──────────────────────────┐
            │ mode switch · HUD · launch controls · flaw panel · timeline · replay │
            └───────────────┬───────────────────────────────┬──────────────────┘
                            │ FlightRecord                  │ FlightRecord
      ┌─────────────────────┴──────────┐      ┌─────────────┴──────────────────┐
      │ Design flight                  │      │ Mission flight                 │
      │ src/ork  → RocketModel + Motor │      │ rocket-physics/ (VehicleSpec)  │
      │ src/physics (Barrowman 6-DOF)  │      │ flyAscent, autopilot, orbits   │
      │ src/physics/flaws              │      │ src/mission/adapter.ts         │
      └─────────────────────┬──────────┘      └─────────────┬──────────────────┘
                            └───────────────┬───────────────┘
                              src/render + src/world (three.js)
                    rocket mesh · effects · arrows · Earth, Moon, planets · clock
```

Rules that keep this simple:

- **Two physics engines stay separate.** The model-rocket sim (Barrowman, 2 ms step, validated against OpenRocket) and the orbital engine (guidance, staging, J2) solve different problems. Neither is rewritten into the other. `rocket-physics/` stays a dependency-free folder with its own tests.
- **One contract between physics and view: `FlightRecord`.** Both modes produce the same recorded flight; the view only replays records. Live flight is "replay of a record that is still growing".
- **Simulate first, then replay.** Mission flights run in a Web Worker (a full ascent takes seconds of CPU), post samples back, and the scene plays them. This reuses the existing replay scrubber and keeps the frame rate independent of the physics.
- **All frame conversion lives in one file**, `src/mission/adapter.ts`, with unit tests. Nothing else knows the orbital engine's conventions.

## The shared contract

```ts
interface FlightSample {
  t: number;              // s since liftoff
  pos: Vec3;              // app frame, metres, Earth-centred
  quat: Quat;             // app convention, body +Y is the nose
  vel: Vec3;              // app frame, m/s
  altitude: number; speed: number; mach: number; q: number;
  accelG: number; mass: number; thrust: number;
  stage: number;          // index of the active stage
  stageThrottle?: number[];   // one entry per vehicle stage, 0..1; 0 when the engine is off or the stage is gone
  skinTemp?: number;          // K
  fairingDeltaP?: number;     // Pa
  heatFlux?: number;          // W/m^2
  ambientPressure?: number;   // Pa
  latDeg?: number;
  lonDeg?: number;
  downrange?: number;         // m
  verticalSpeed?: number;     // m/s
  pitchDeg?: number;
  alphaDeg?: number;
  apoapsis?: number;          // m above equatorial radius
  periapsis?: number;         // m above equatorial radius
  dvExpended?: number;        // m/s
  phase?: string;             // autopilot phase string
  propellant?: number[];      // kg remaining per vehicle stage, 0 once gone
  health?: Record<string, number>;
}
interface FlightMarker {  // an event or a flaw, shown on the timeline
  t: number; kind: 'event' | 'flaw'; label: string;
  severity?: 'info' | 'warning' | 'critical';
  reference?: number;     // real-flight time for the same event, if known
}
interface FlightFault {
  id: string;
  system: 'pressure' | 'thermal' | 'structure' | 'propulsion';
  severity: 'info' | 'warning' | 'critical';
  stage?: number;
  t: number;
  tFirst?: number;
  tLast?: number;
  value: number; limit: number; unit: string;
  title: string; detail: string; fix: string;
}
interface FlightOutcome {
  outcome: 'nominal' | 'degraded-orbit' | 'suborbital' | 'impact' | 'breakup' | 'pad-abort';
  summary: string;
  perigeeAltitude: number; apogeeAltitude: number; apogeeShortfall: number;
  impact: { latDeg: number; lonDeg: number; t: number } | null;
}
interface FlightRecord {
  source: 'design' | 'mission';
  samples: FlightSample[]; markers: FlightMarker[];
  orbit?: { apoapsis: number; periapsis: number; inclinationDeg: number };
  vehicleName?: string;
  /** Seconds since liftoff when each stage separated, same index as the vehicle's stages; null if it never did. */
  stageSeparation?: (number | null)[];
  /** Seconds since liftoff when the fairing was jettisoned; null if never or if there is none. */
  fairingSeparation?: number | null;
  /** Earth rotation: angle (rad) of the prime meridian from the inertial X axis at liftoff, and rate (rad/s). */
  earth?: { angleAtLiftoff: number; rate: number };
  reachedTarget?: boolean;
  faults?: FlightFault[];
  scenario?: string;
  epochJD?: number;
  liftoffSimTime?: number;
  healthPeaks?: { key: string; value: number; t: number }[];
  iipTrack?: { t: number; latDeg: number; lonDeg: number }[];
  outcome?: FlightOutcome;
  failureCase?: string;
}
```

Round 1 defines this type and the mission side of it. Design mode is moved onto it in a later round, only if that is cheap; until then the existing replay path stays as it is.

## Frames

| | Orbital engine (`rocket-physics`) | App (`src/`) |
|---|---|---|
| Axes | Z-up, Earth-centred inertial; Earth rotates under it | Y-up, Earth-centred; Earth fixed, pad at `(0, R+alt, 0)` |
| Body nose axis | +X | +Y |

Vector conversion is a fixed rotation: `app = (x, z, −y)` (determinant +1, so handedness is kept). In mission mode the scene is driven in the inertial frame and the Earth mesh is turned by the engine's Earth rotation angle, so the pad moves with the ground. Design mode keeps its fixed-Earth frame; a model rocket never notices. The quaternion storage order of each side must be read from the code and pinned by tests, not assumed.

## Mission mode, concretely

- `src/mission/adapter.ts` — frame conversion, `Telemetry`/state → `FlightSample`, engine events → `FlightMarker`.
- `src/mission/worker.ts` — runs `flyAscent(lvm3(), { site: SITES.sriharikota }, …)`, posts samples in batches.
- `src/mission/vehicles.ts` — list of selectable vehicles and their real-flight reference event times.
- `src/render/launcherMesh.ts` — simple staged launcher mesh built from `VehicleSpec` (core, strap-on boosters, upper stage, fairing), parts detach at staging markers.
- App: mode switch, vehicle picker, timeline panel "simulated vs actual", orbit readout, map view shows the resulting orbit ellipse.

## Remaining work, in round order

| Round | Scope | Done when |
|---|---|---|
| 1 | Consolidate both codebases into one committed branch. Wire `rocket-physics` into the app build. `FlightRecord` type. Frame adapter with tests. Fix the bundled sample's 18 mm motor in a 17 mm mount. | Both test suites and the build pass from one tree; adapter tests pass |
| 2 | Mission worker + headless test: LVM3 flight comes back as a `FlightRecord` with markers and reference times | A Vitest test receives the full record |
| 3 | Mission mode in the scene: launcher mesh, staging, rotating Earth, cameras, timeline panel | LVM3 flies to orbit in the browser |
| 4 | Phone layout for mission mode, Android build, service worker caches the worker bundle | APK runs the mission on the emulator |
| 5 | Model accuracy: fin CNα is ~20 % low (stability margin reads 0.5–1 calibre high), dry mass 3.4 % high, validate on a second and third OpenRocket design | Margin within 0.3 calibre on three designs |
| 6 | Multi-stage `.ork` flight (currently stacked into one rocket with a warning) | The two-stage example flies with separation |
| 7 | ISRO content: RH-200 sounding rocket sample, a second mission vehicle, lunar transfer view using the library's Lambert example | — |
| 8 | Polish and submission: planets aligned to real sky, transonic drag, README, demo script, deploy the site | — |

Rounds 5–8 are independent of each other and can be reordered by what the judges need. The single-file viewer's internal-systems visuals are a possible source for round 8 cutaway polish; the file itself is not merged.

## How a round works

1. Paste `docs/opencode/ROUND-NN.md` into opencode, started in the repo root on the `app` branch.
2. opencode does the steps in order, commits after each, and appends to `docs/PROGRESS.md`: what it finished, what failed, the last test output.
3. The next prompt is written from `docs/PROGRESS.md` and the code, not from memory.

Each prompt is sized for a free model: small steps, exact commands, a check after every step, and a rule to stop and record instead of improvising when a check fails.
