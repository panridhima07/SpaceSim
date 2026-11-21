# Round 1 — one tree, one build, frame adapter

Paste everything below the line into opencode. Start opencode in `C:\Users\medha\Desktop\Hackathons\Astra` (the main checkout, not a worktree).

---

You are working on Astra, a hackathon project: a TypeScript + Three.js + Vite web app (also packaged for Android with Capacitor) that flies rockets in 3D. The working code currently sits uncommitted in two other folders. Your job in this session is to bring it into this repository on one branch, make it build as one project, and add a small adapter module. Do not add features beyond the steps below.

## Rules

- Do the steps in order. After each step run its check. If the check passes, commit and go on.
- If a check fails, try to fix it at most twice. If it still fails, stop, write what happened in `docs/PROGRESS.md` (the command, the last 30 lines of output, what you tried), commit that file, and end the session. Do not skip ahead and do not delete or weaken tests to make a check pass.
- The shell is PowerShell on Windows. Node is v26. Run commands from `C:\Users\medha\Desktop\Hackathons\Astra` unless a step says otherwise.
- Read a file before you change it. Change only what the step names.
- Commits: local only. Never run `git push`, never open a pull request. Plain one-line messages. No mention of any AI tool or assistant, and no `Co-Authored-By` line, in any commit message or file.
- Do not touch the folders under `.claude\worktrees\` except to copy from them. Do not touch `space-flight-godot\`.
- `rocket-physics\` must keep working on plain Node with no install: inside it, only erasable TypeScript syntax (no `enum`, no `namespace`, no parameter properties), imports keep their `.ts` extension, type imports use `import type`. In this round you should not need to edit anything inside `rocket-physics\src`.

## Step 1 — branch and copy

```powershell
git switch -c app
```

Copy the web app (repo root of one worktree) and the physics library (a folder in another). `robocopy` exit codes 0 to 7 mean success; only 8 or higher is a failure.

```powershell
robocopy ".claude\worktrees\space-flight-builder-plan-975db2" "." /E /XD node_modules dist .claude .git build .gradle /XF .git
robocopy ".claude\worktrees\pensive-margulis-f3e2f3\rocket-physics" "rocket-physics" /E /XD node_modules
New-Item -ItemType Directory -Force docs\opencode | Out-Null
Copy-Item ".claude\worktrees\free-plan-prompt-breakdown-84eb4a\docs\SYSTEM_DESIGN.md" docs\
Copy-Item ".claude\worktrees\free-plan-prompt-breakdown-84eb4a\docs\opencode\ROUND-01.md" docs\opencode\
```

Then add these lines to `.gitignore` if they are missing: `space-flight-godot`, `.claude`.

Read `docs\SYSTEM_DESIGN.md` and `docs\PLAN.md` now. They describe the design you are building toward.

Check:

```powershell
npm install
npm test
npm run build
```

Expected: 211 tests pass in 20 files, build succeeds. Then, in `rocket-physics\`: `npm test` — expected 200 pass, 0 fail (takes about 40 s).

Before committing, run `git status --short` and confirm that `node_modules`, `dist`, `fixtures/external`, `space-flight-godot` and any `android/**/build` folder are not listed. Then:

```powershell
git add -A
git commit -m "Add web app and rocket physics library"
```

Create `docs\PROGRESS.md` with a heading `## Round 1` and one line per finished step. Update it after every step from here on and include it in each commit.

## Step 2 — fix the bundled sample rocket

`src\ork\sample.ts` holds a built-in sample design whose motor mount (inner tube) is too narrow for its 18 mm motor, so the app's own pre-flight check reports a motor-fit flaw on the sample. Read the file and the motor-fit rule in `src\physics\flaws.ts`, then change the mount's dimensions in the sample so a standard 18 mm motor fits (inner diameter at least 18 mm, with a sensible wall thickness, still inside the body tube). Add one test next to the existing parser or flaws tests asserting that the sample produces no motor-fit flaw.

Check: `npm test` passes. Commit: `Fix motor mount size in sample rocket`.

## Step 3 — let the app import the physics library

In the root `tsconfig.json` add `"allowImportingTsExtensions": true` to `compilerOptions`. Leave `include` as it is.

Create `src\mission\engine.ts` containing only re-exports of what the app will need from the library, imported from `'../../rocket-physics/src/index.ts'`: `flyAscent`, `Simulation`, `SITES`, `lvm3`, `twoStageKerolox`, `noseDirection`, and the types `Telemetry`, `FlightResult`, `VehicleSpec`, `SimConfig`. Check the real export names in `rocket-physics\src\index.ts` first and use those; if one of these names does not exist, leave it out and note it in `docs\PROGRESS.md`.

Add `src\mission\engine.test.ts` with one Vitest test: build a `Simulation` for `twoStageKerolox(12000)` at `SITES.sriharikota`, and assert that its initial altitude from `sim.diag` is within 100 m of the site altitude and that mass is positive. Use the "manual loop" example in `rocket-physics\README.md` for the call shapes. Do not fly a full ascent in this test.

Check: `npm run typecheck`, `npm test`, `npm run build` all pass. If typecheck reports errors inside `rocket-physics\` caused by the root compiler options, fix them by adjusting the root `tsconfig.json` options, not by editing library source. Commit: `Wire rocket physics library into the app build`.

## Step 4 — the shared flight record type

Create `src\mission\record.ts` with the three interfaces `FlightSample`, `FlightMarker` and `FlightRecord` exactly as written under "The shared contract" in `docs\SYSTEM_DESIGN.md`. Import `Vec3` and `Quat` from `src\types.ts`. Types only, no logic.

Check: `npm run typecheck`. Commit: `Add shared flight record types`.

## Step 5 — the frame adapter

The library works in a Z-up Earth-centred inertial frame with the rocket's nose along body +X. The app works in a Y-up frame with the nose along body +Y. Create `src\mission\adapter.ts` with pure functions and no three.js import:

1. `eciToApp(v: Vec3): Vec3` returning `[v[0], v[2], -v[1]]`, and its inverse `appToEci`.
2. `attitudeToApp(q)`: takes the library's attitude quaternion (body-to-ECI, nose = body +X) and returns the app's quaternion (body-to-app-frame, nose = body +Y). Before writing it, read `rocket-physics\src\math\vec.ts` to find the library's quaternion component order and its `qrot` function, and read how `Quat` is ordered and used in `src\physics\vec.ts` and `src\render\rocketMesh.ts`. Write the two orders you found as a comment at the top of `adapter.ts`.
3. `toSample(sim): FlightSample`: fills a `FlightSample` from a library `Simulation` using `sim.diag`, `sim.telemetry()`, the state vectors and `sim.missionTime`. Read `rocket-physics\src\sim\simulation.ts` for the real field names. If a field has no source, set it to 0 and list it in `docs\PROGRESS.md`.

Create `src\mission\adapter.test.ts`:

- `eciToApp` maps ECI +Z (north pole) to app +Y, and `appToEci(eciToApp(v))` returns `v` for a few vectors.
- The conversion keeps handedness: for `a = [1,0,0]`, `b = [0,1,0]`, `eciToApp(cross(a,b))` equals `cross(eciToApp(a), eciToApp(b))`.
- Attitude: for at least three different library quaternions (identity plus two arbitrary unit quaternions), rotating body +Y by `attitudeToApp(q)` using the app's own quaternion-rotate function gives the same vector as `eciToApp(qrot(q, [1,0,0]))` to 1e-9. This is the test that proves the nose points the right way.
- `toSample` on a freshly built `Simulation` at Sriharikota returns a `pos` whose length is within 1 km of Earth's radius plus site altitude, and finite numbers in every field.

Check: `npm run typecheck` and `npm test` pass. Commit: `Add frame adapter between physics library and app`.

## Step 6 — finish

Run the full set once more and paste the summary lines into `docs\PROGRESS.md`:

```powershell
npm run typecheck
npm test
npm run build
```

and `npm test` inside `rocket-physics\`.

Finish `docs\PROGRESS.md` for this round with three short lists: **Done**, **Not done or failed** (with the reason), and **Things I noticed** (anything in the code that contradicts `docs\SYSTEM_DESIGN.md` or these instructions, such as a different quaternion order, a missing export, or a field with no source). Commit: `Update progress notes`. Then stop. Do not start mission mode UI, workers, or meshes; those are later rounds.
