# AG 04 — put the finished physics on screen, fix the trajectory, one UI everywhere

Paste everything below the line into Antigravity, started in `C:\Users\medha\Desktop\Hackathons\Astra` on branch `app` (the main checkout, not the `ag` worktree: `ag-work` is behind `app` and does not have the physics).

Run this only after Physics 01 and Physics 02 are committed (`docs\PHYSICS-PROGRESS.md` ends with a "Physics 02 Summary").

---

You are continuing work on Astra, a hackathon project: a TypeScript + Three.js + Vite web app (Capacitor for Android) that designs and flies rockets in 3D. The orbital physics is finished and tested, but none of it is visible. The only way to fly the LVM3 mission is `window.astraRunMission()` in the browser console, which returns a `FlightRecord` and draws nothing. The renderers for it (`src\render\launcherMesh.ts`, `launcherPlume.ts`, `launcherStaging.ts`, `orbitLine.ts`, `launchComplex.ts`) are written and tested but imported by nothing.

This session does three things:

1. **Mission mode** — fly LVM3-M4 from Sriharikota to orbit in 3D inside the app, driven by a `FlightRecord`, with the health, failure, outcome and predicted-path data the physics now produces.
2. **Trajectory** — a correct flight path line in both simulations (the model-rocket flight and the mission).
3. **One UI** — the mission screen, the flight screen, the builder and the Moon landing page all use the same ASTRA look (the `sfb-` panel and button system in `src\app\style.css`).

## Before you start

Read, in this order: `docs\SYSTEM_DESIGN.md` (sections "The shared contract", "Frames", "Mission mode, concretely"), `docs\PHYSICS-PROGRESS.md`, everything in `src\mission\`, the five render files named above, `src\app\main.ts`, `src\app\ui.ts`, `src\app\uiTypes.ts`, `src\app\style.css`, `src\builder\view.ts` (the pattern to copy for a mode with its own scene), `src\render\effects.ts` (`buildTrajectoryLine`), and `docs\AG_PROGRESS.md` (your own earlier log).

Precondition check:

```powershell
npm run typecheck
npm test
npm run build
```

All three must be green. Record the baseline test count. If not green, write what you found in `docs\AG_PROGRESS.md` under a `# TASK-04` heading and stop.

Where a name in this prompt differs from the code, the code wins: adapt, and note the difference in the progress file.

## Rules

- Work in the order A to E. After each part run its checks; commit when green. If a check still fails after two attempts at a fix, stop, record the command, the last 30 lines of output and what you tried, commit the progress file, and end. Never delete, skip or loosen an existing test.
- PowerShell on Windows.
- Commits are local only; never push. Stage files by name. Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git restore`, `git checkout -- <file>` or `git reset`: the tree has someone else's uncommitted work (`src\auth\`, `src\app\boot.ts`, `src\landing\boot.ts`, `.env.example`, `sentinel-hackathon\`, and edits in `index.html`, `landing.html`, `package.json`, `package-lock.json`, `src\app\builderUi.ts`, `src\app\main.ts`, `src\app\style.css`, `src\landing\main.ts`, `android\`). Keep those edits intact. When you must edit one of those files, add your change beside theirs and say so in the progress file; that file is then committed with both changes, which is accepted.
- One-line commit messages, with no mention of any AI tool and no `Co-Authored-By` line, in commits or files.
- Do not edit anything under `rocket-physics\`, `src\physics\`, or the physics behaviour of `src\mission\`. This session only displays what they produce. If you find a physics bug, record it and move on.
- No new npm dependencies.
- Every control must work with touch and be at least 44 px tall on a phone. Check every screen at 390 x 844 and at 1440 x 900.
- Append to `docs\AG_PROGRESS.md` under `# TASK-04` after each part: status, commit hash, what changed, test counts, open issues.

---

## Part A — mission mode, the 3D view

Create `src\app\missionView.ts`. Follow `src\builder\view.ts`: the module owns its own `THREE.Scene` and camera and is drawn with the shared renderer.

```ts
export interface MissionView {
  setRecord(record: FlightRecord, def: MissionDef): void;   // rebuilds vehicle, trail, orbit
  setTime(t: number): void;                                 // mission seconds; poses everything
  setCamera(mode: 'chase' | 'pad' | 'map'): void;
  setEnabled(on: boolean): void;                            // pointer listeners on/off
  resize(width: number, height: number): void;
  render(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}
export function createMissionView(domElement: HTMLElement): MissionView
```

**Frame.** `FlightSample.pos` is in the app frame, Earth-centred and inertial (Y is the north pole). The Earth turns under it: at mission time `t` its angle is `record.earth.angleAtLiftoff + record.earth.rate * t`, applied as `rotation.y` of an Earth group. A three.js `SphereGeometry` with a standard equirectangular Earth map already has longitude 0 on +X and 90 E on −Z at `rotation.y = 0`, which matches the app frame; pin this with a test (below) rather than trusting it.

**Floating origin.** Positions are about 6.4e6 m and the vehicle is 43 m long. Keep the vehicle at the scene origin: one `world` group positioned at minus the vehicle position each frame, with the Earth group inside it.

**Earth.** Sphere with `earth_atmos_2048.jpg` from `public\assets\space\` (load it the way `src\world\solarSystem.ts` does, and do nothing when the file or the DOM is missing so tests run). Scale Y by 6356752 / 6378137. A 128-segment sphere sags up to 1.9 km below the true surface, so sink the sphere 2 km and add a flat ground disc of about 80 km radius, edge faded to transparent, in the Earth group at the launch site. Put `buildLaunchComplex` on it. Anchor the disc so the base of the vehicle sits on it at the first sample; do not assume whether `pos` is the base or the centre of mass, measure it from the first sample and the mesh.

**Sky.** Background colour goes from sky blue on the pad to black by about 60 km (`exp(-altitude / 12000)` is enough). Add a star field that fades in as the sky darkens. One directional light fixed in the inertial frame so the pad is lit at liftoff, plus a low ambient.

**Vehicle.** Build a `LauncherSpec` from `def.vehicle()` (name, length, radius, engineCount and `parallel` of each stage, payload, fairing) and pass it to `buildLauncherMesh`. A stage is solid when `stage.engine.thrustCurve` is defined; pass that to `buildLauncherPlumes`. Each frame, from `snapshotAt(record, t)`:

- pose: `quat` is already in the app convention with the nose on body +Y, the same as the mesh;
- staging: `updateLauncherStaging` with `t - record.stageSeparation[i]` (null until it separates) and the same for `record.fairingSeparation`;
- plumes: `updatePlumes` with `snapshot.stageThrottle` and `snapshot.ambientPressure`;
- if `record.outcome.outcome` is `'breakup'` and `t` is at the last sample, hide the vehicle and show a short expanding fireball.

**Cameras.** `chase`: orbits the vehicle; drag rotates, wheel and pinch zoom; up is the local vertical; never below the ground while near the pad. `pad`: fixed on the ground about 250 m east of the pad, tracks the vehicle and narrows its field of view as the vehicle recedes. `map`: orbits the Earth's centre from about 3 Earth radii so the whole path and orbit are visible.

**Tests** (`src\app\missionView.test.ts`, no WebGL: test the pure helpers you export for this):

- the function that turns latitude, longitude and Earth angle into an app-frame position puts Sriharikota (13.72 N, 80.23 E) within 5 km of the first sample of a nominal flight (fly it once at module level with `flyMission(getMission('lvm3-m4')!)`);
- the `LauncherSpec` built from LVM3 has two entries with `parallel` grouped as one S200 stage of count 2, or whatever the code's vehicle actually defines, and a fairing;
- separation ages are null before and positive after each time in `record.stageSeparation`.

Check: `npm run typecheck`, `npm test`. Commit.

## Part B — trajectory

**B1. Mission path.** Three lines, all built once per record and revealed by `t`:

- **Flown path**, in the Earth group, so it is the path over the ground and stays attached to the pad as the Earth turns. For each sample rotate `pos` about Y by minus the Earth angle at that sample's time. Draw only samples with time up to `t` (`setDrawRange`). Store vertices relative to the first sample and position the line at the first sample, so 32-bit vertex precision is centimetres, not half a metre.
- **Predicted coast**, from `coastPath(record, t, 1800, 30)` in `src\mission\predict.ts`. It costs real CPU: recompute at most twice a second and only when `t` has changed. Convert each point to the Earth-fixed frame with its own time, so the line ends on the impact marker. Dashed, in the warning colour. Hide it once `snapshot.periapsis` is above 100 km.
- **Impact point**, a ring on the surface at `snapshot.iip` (null hides it), sized to stay visible from the map camera.
- **Final orbit**, in the inertial `world` group, shown when `record.outcome.perigeeAltitude` is above 80 km. `record.orbit` has no node or argument of perigee, so compute the elements from the last sample's `pos` and `vel` (convert with `appToEci`, mu = 3.986004418e14) and draw with `orbitPoints` and `buildOrbitLine`.

Tests: the flown path's first vertex is at the pad and its last is at the last sample's altitude within 1 km; the elements computed from the last nominal sample give a perigee altitude within 5 km of `record.orbit.periapsis` and an apogee within 50 km of `record.orbit.apoapsis`.

**B2. Model-rocket flight path.** In `src\app\main.ts` the path is `buildTrajectoryLine()` from `src\render\effects.ts`, fed by `trail.push(state.pos)` in `updateSmokeAndTrail`. Start the app (`npm run dev`), load the sample, fly it, and write down in the progress file exactly what is wrong with the line before changing anything. Known from reading the code, confirm each by running it:

- the buffer holds 5000 points at 20 Hz of simulated time, so after 250 s of flight the start of the path is thrown away (`points.shift()`), and long parachute descents lose the launch;
- points are only pushed while the flight is live (`replayT === null`), so the path is not tied to the replay scrubber: scrubbing back does not shorten it;
- nothing is pushed while the trail toggle is off, so turning it on mid-flight shows a path with a hole.

Fix: build the line from the simulation's own state log (the one `logAt` reads) instead of a separately accumulated list, so it is always complete, decimated to the buffer size instead of truncated, and during replay drawn up to the scrub time. Keep the existing `buildTrajectoryLine` signature working or update its tests in `src\render\effects.test.ts` to the new behaviour without weakening them. Add a test for: a log longer than the capacity keeps its first and last points; a draw limit at time `t` shows no point later than `t`.

Check: `npm run typecheck`, `npm test`. Commit.

## Part C — mission mode, the screen

Create `src\app\missionUi.ts` and `src\app\mission.css`. Use the existing system: a root with class `sfb-root` (it carries the colour variables), panels with `sfb-panel`, buttons with `sfb-btn` / `sfb-btn-primary`, titles with `sfb-section-title`, numbers in `var(--sfb-mono)`. New class names start with `msn-`. No new colours: critical, warning, info and good already exist as variables.

```ts
export interface MissionUiCallbacks {
  onExit(): void;
  onFly(caseId: string): void;        // 'nominal', a failure case id, or a scenario id
  onPlayPause(): void;
  onWarp(warp: number): void;         // 1, 5, 20, 100
  onScrub(t: number): void;
  onCamera(mode: 'chase' | 'pad' | 'map'): void;
}
export interface MissionUi {
  setVisible(on: boolean): void;
  setBusy(text: string | null): void;                       // "Computing flight…" over the scene
  setRecord(record: FlightRecord, def: MissionDef): void;   // builds timeline and health rows once
  update(snapshot: FlightSnapshot, playing: boolean, warp: number): void;   // call at most 10 times a second
}
```

Panels:

- **Header**: vehicle name, a Back button, a picker with Nominal, each `def.failureCases` entry (show its `note`), and the scenarios `blocked-vent`, `regulator-low`, `hot-grain`, and a Fly button.
- **Telemetry**: T+ time, altitude, speed, Mach, dynamic pressure, g, mass, downrange, apoapsis and periapsis, phase, and one propellant bar per stage from `snapshot.propellant` (full = its value in the first sample).
- **Timeline**: every marker of kind `event` with its simulated time, the real LVM3-M4 time (`marker.reference`) and the difference in seconds; flaws listed with their severity colour. The latest event at or before `t` is highlighted. Clicking a row scrubs to it.
- **Health**: one bar per key of `snapshot.health` (1.0 is the limit): good below 0.8, warning to 1.0, critical above. Readable names, not the keys (`maxQ` → "Dynamic pressure", `fairingDp` → "Fairing pressure difference", and so on). Under it, `snapshot.activeFaults` with title, detail and fix.
- **Transport**: play/pause, the four warp speeds, the scrubber, the three camera buttons, and the predicted impact latitude and longitude when `snapshot.iip` is set.
- **Outcome**: when `t` reaches the last sample, a banner with `record.outcome.outcome`, `record.outcome.summary`, and the final perigee x apogee in km.

Phone layout: telemetry collapses to one compact row at the top, transport stays at the bottom, timeline and health open as a sheet from one button. Nothing may cover the vehicle in the middle third of the screen.

Tests (`src\app\missionUi.test.ts`, jsdom, same style as `src\app\ui.test.ts`): timeline rows equal the number of event markers and show the reference time where one exists; a health value of 1.2 gets the critical class and 0.5 the good class; the outcome banner is hidden before the end and shown at it; clicking a timeline row calls `onScrub` with that marker's time.

Check: `npm run typecheck`, `npm test`. Commit.

## Part D — wire it into the app

In `src\app\main.ts`:

- `appMode` gains `'mission'`. In `frame`, mission mode advances its own playback time by `realDt * warp` (clamped to the record), calls `missionView.setTime`, updates the UI at most 10 times a second, renders with `missionView.render(renderer)`, and returns, the same shape as the builder branch.
- `enterMission()`: disables `cameraRig`, hides `ui`, shows the mission UI, and flies the nominal case with `runMission('lvm3-m4', opts)` from `src\mission\client.ts` (it runs in a Web Worker and takes 4 to 10 s; show the busy state). Cache records by case id so re-selecting a case is instant. Failure cases and scenarios are flown with `destructive: true`. A rejected promise shows the error in the UI and leaves the previous record on screen.
- `exitMission()` restores the flight screen exactly as it was.
- The window resize handler calls `missionView.resize`.
- Entry points: a "Fly LVM3 mission" button in the brand row of `src\app\ui.ts` (add an optional `onMission` to `UICallbacks` in `uiTypes.ts`), a matching button in the phone rail, and a fourth button on the title screen in `src\app\hero.ts`.
- Leave the `astraRunMission` console hook in place.

Check: `npm run typecheck`, `npm test`, `npm run build`. Then run `npm run dev` and confirm by eye, writing each result in the progress file:

1. The mission button opens mission mode and the flight computes without freezing the page.
2. At T+0 the vehicle stands on the pad at Sriharikota, upright, on the ground, not buried and not floating.
3. S200 boosters leave at about T+127 s, the fairing at about T+195 s, L110 at about T+306 s; plumes switch with the engines.
4. The flown path starts at the pad and follows the vehicle with no jump, gap or straight chord across the Earth.
5. In the map camera the final orbit is a 170 x 36 500 km ellipse that passes through the vehicle's cutoff position.
6. `gimbal-lock` ends in a breakup near T+41 s with an impact marker in the Bay of Bengal near 13.7 N, 80.3 E; `c25-shutdown` ends suborbital with the marker near 10.7 N, 115.4 E. These numbers are from `docs\PHYSICS-PROGRESS.md`.
7. Scrubbing backwards re-attaches the stages and shortens the path.
8. Back returns to the flight screen with the model rocket still loaded.

Commit.

## Part E — one UI everywhere

The flight screen (`src\app\ui.ts`) is the reference. Bring the others to it without changing what they do:

- **Builder** (`src\app\builderUi.ts`): same panel, button, title and input styles as the flight screen; no leftover hard-coded colours or fonts that differ from the variables on `.sfb-root`.
- **Moon landing** (`landing.html`, `src\landing\`, `src\lunar\`): same variables, panels, buttons and type scale. If it has its own stylesheet, move the shared variables into one file both pages import instead of copying them.
- **Parts page** (`parts.html`) and the **title screen** (`src\app\hero.ts`, `hero.css`): same variables and button shapes.
- **Flight simulation HUD**: check the telemetry, events, flaw list, replay scrubber and stress-test panel at both screen sizes; fix anything that overlaps, overflows, is cut off by the Android status or navigation bar, or is unreadable over a bright sky.

Before editing, list every mismatch you found (screen, element, what differs) in the progress file, then fix them in that order. Do not restructure markup that tests depend on; `src\app\ui.test.ts` and `src\app\builderUi.test.ts` must pass unchanged.

Check: `npm run typecheck`, `npm test`, `npm run build`, and look at every screen at 390 x 844 and 1440 x 900. Commit.

## Finish

Append a `## TASK-04 summary` to `docs\AG_PROGRESS.md`: final test counts for `npm test`, results of the eight visual checks in Part D, the list of UI mismatches fixed in Part E, the size of the built JS chunks from `dist\assets`, anything in this prompt that did not match the code, and everything not done. Commit the progress file.
