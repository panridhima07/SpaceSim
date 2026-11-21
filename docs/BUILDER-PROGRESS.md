# Space Flight Builder — Build Mode Progress

## Backlog

- [x] **Task 1: Thin end-to-end build slice** — `src/builder/parts.ts`, `src/builder/design.ts`, `src/builder/view.ts`, `src/app/builderUi.ts`, mode switch in `main.ts` / `ui.ts` / `uiTypes.ts` / `style.css`. Palette with starter parts, stack them, see live 3D rocket on neutral background with height ruler, Go to pad, fly, Back to builder.
- [x] **Task 2: Full parts palette (8 categories & standard sizes)** — Complete preset catalogue in `src/builder/parts.ts` (nose cones, body tubes, transitions, fin sets, motor mounts & motors, recovery, payload & mass, rings & bulkheads) with category tabs in `builderUi.ts`.
- [ ] **Task 3: Snap points, diameter matching & drag/tap placement** — `src/builder/snap.ts` + tests, 3D snap highlights in `view.ts`, drag-from-palette (desktop) and tap-part then tap-snap-point (phone & desktop), auto-transition offer on diameter mismatch.
- [ ] **Task 4: 3D picking, selection & live inspector** — Raycast part picking in `view.ts`, cutaway toggle, full property inspector with sliders + number boxes in `builderUi.ts`, fast incremental mesh updates.
- [ ] **Task 5: Move, duplicate, delete, undo & redo** — `src/builder/history.ts` + tests, stack reorder, duplicate, delete, desktop shortcuts (`Ctrl+Z`/`Ctrl+Y`/`Delete`/`Ctrl+D`) and >=44px mobile buttons.
- [ ] **Task 6: Live engineering readout, pre-flight flaws & post-flight flaw mapping** — Length, mass, CG/CP markers, colour-coded stability margin, TWR, live pre-flight flaws while building; post-flight "Back to builder" lists flight flaws beside the parts that caused them.
- [ ] **Task 7: Save, load, thumbnails, JSON & .ork import to builder** — `src/builder/storage.ts` + tests, localStorage gallery with thumbnails, JSON export/import, open imported `.ork` directly in builder.
- [ ] **Task 8: OpenRocket `.ork` export & round-trip tests** — `src/builder/orkExport.ts` + tests (inverse of `src/ork/parser.ts`), round-trip build -> export -> parse -> compare, download `.ork` button.
- [ ] **Task 9: Multi-stage stacks & staging simulation** — Decoupler part, multi-stage `Design` & `RocketModel`, staging physics in `src/physics/sim.ts` + tests without altering existing OpenRocket validation tolerances.
- [ ] **Task 10: Side boosters & radial symmetry** — Side-mounted boosters with radial symmetry (2/3/4x) and rendering.
- [ ] **Task 11: Challenges list** — Built-in engineering challenges ("Reach 300 m and land under 6 m/s with a C motor", etc.) evaluated on flight completion.
- [ ] **Task 12: Part colours, decals & first-run tutorial** — Per-part colour customization in `types.ts` / `rocketMesh.ts` / inspector, and short first-run tutorial.
- [ ] **Task 13: Play-test, phone polish & Android build verification** — Full desktop + 412x840 mobile play-test and `open-app.cmd build`.

## Progress Log

*(Started 2026-11-22. Baseline: 280 tests passing, `tsc --noEmit` clean.)*
- **Task 1 done:** Created `src/builder/parts.ts`, `src/builder/design.ts`, `src/builder/view.ts`, `src/app/builderUi.ts` + unit tests (`parts.test.ts`, `design.test.ts`). Wired Build/Pad mode switch into `src/app/main.ts`, `src/app/ui.ts`, `src/app/uiTypes.ts`, `src/app/cameras.ts`, `src/app/style.css`. 289 tests passing, `tsc --noEmit` and `npm run build` green.
- **Task 2 done:** Expanded `src/builder/parts.ts` to 40+ real-dimension presets across all 8 categories (BT-20/50/55/60/80 & 57 mm airframes; 18/24/29/38/54 mm motor mounts verified against `motors.ts`; transitions, fin sets, streamer & parachutes, payloads, centering rings, bulkheads, launch lug) + `createTransitionBetween` helper. 11/11 builder tests passing.
