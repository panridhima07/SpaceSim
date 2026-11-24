# ASTRA — Rocket Builder & Spaceflight Simulator

Build a rocket, see it in 3D on a launch pad, fly it with a 6-DOF physics sim, and get a list of where and when the design fails. Import OpenRocket (`.ork`) designs or build from parts, fly real-vehicle missions (LVM3, Falcon 9, PSLV), and go on to the Moon. One codebase, two builds: a website and an Android app.

Built for ASTRA 2026 (ANTERiX, VIT Bhopal). Plan and validation numbers: [docs/PLAN.md](docs/PLAN.md). Round-by-round log: [docs/PROGRESS.md](docs/PROGRESS.md).

## Goal

Turn this from a hackathon demo into a proper website and app for rocket building and simulation, **in 2 days**. The product loop is: **design a rocket, fly it, read the flaw report, tweak, refly.** Anyone can open a URL, build, simulate and share a design.

### 2-day plan

Status as of 23 Nov 2026. Nothing below is ticked yet: each item bundles several parts, and the notes say which parts exist in code.

**Day 1: ship it and make it persistent**
- [ ] Deploy the static build to a real URL (Vercel) and set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the host's environment
  - `npm run deploy` is ready. The folder is linked to a Vercel project (`.vercel/project.json`), but no live URL is recorded in the repo.
- [ ] Real routes for landing, builder and simulator; PWA manifest and offline caching
  - Separate HTML pages (`index.html`, `landing.html`, `parts.html`, `presentation.html`). Manifest and service worker exist (`public/manifest.webmanifest`, `public/sw.js`).
- [ ] Supabase tables with row-level security: `rockets` (owner, name, design JSON, public flag) and `flights` (rocket, result summary)
  - `supabase/migrations/0001_cloud_data.sql` turns on row-level security for 5 tables: `profiles`, `designs`, `rocket_files`, `import_corrections`, `sim_runs`. There is no `rockets` or `flights` table. `0002_training_consent.sql` limits the team's training export to users whose consent is still on. Whether the migrations are applied to the live project is not verified (`supabase db push` applies them).
- [ ] Save designs from the builder, a "My rockets" page, and read-only share links (`/r/<id>`)
  - Saving to the cloud works for signed-in users (`src/cloud/designSync.ts`). There is no "My rockets" page and no `/r/<id>` links. Share links carry the design in the URL hash (`src/io/shareLink.ts`).

**Day 2: one loop, then polish**
- [ ] Builder to simulator to results (apogee, delta-v, orbit reached, flaws) to tweak to refly, with a compare-flights view
  - Build, fly, flaw report and "Back to builder" exist. No compare-flights view was found in the code.
- [ ] Mobile layout pass, first-run tutorial, auth that never blocks the app when offline
  - Mobile layout pass and first-run tutorial exist (`src/app/builderUi.ts`, `src/app/mission.css`). The cloud layer is written to fail quietly offline (`src/cloud/store.ts`). Not checked end to end.
- [ ] Cut 3D load time; rebuild the Android APK from the final web build
  - A debug APK exists at `android/app/build/outputs/apk/debug/app-debug.apk` (built 23 Nov 2026). Load time was not measured.
- [ ] Final demo run-through on the deployed URL
  - Not done: there is no deployed URL to run through.

**Out of scope for the 2 days:** public gallery, leaderboards and server-side score validation. The backend is Supabase (auth, Postgres, storage) plus one small serverless function for the stress test (`api/simulate.ts`).

## What is done so far

**Physics and flight**
- `rocket-physics/`: orbital-launch library (6-DOF, RK4, ascent autopilot, guidance, staging, orbit and maneuver tools, fault monitoring) with its own Node tests. Vehicle definitions for LVM3, Falcon 9 and PSLV (`rocket-physics/src/vehicle/`).
- App wiring through `src/mission/`: engine re-exports, frame and attitude adapter, `flyMission` sampling to a shared `FlightRecord`, a worker plus in-thread fallback, mission snapshots and prediction.
- Missions (`src/mission/vehicles.ts`, `src/mission/missions/`): LVM3-M4 / Chandrayaan-3, PSLV-C61 / EOS-09 and Falcon 9 / Starlink, with failure injection, mission health and outcomes.
- Piloted mission flight: fly the mission by hand (`src/mission/pilot.ts`, `src/app/pilotControls.ts`).
- Lunar module: cruise, navigation, terrain and a lander (`src/lunar/`, `landing.html`).
- Model-rocket sim: multi-stage `.ork` flight with stage separation and delayed upper-stage ignition (`src/ork/stageMotors.ts`; `src/ork/rh200.ts` is the RH-200 two-stage sample). Transonic and supersonic wave drag (`transonicWaveCd` in `src/physics/aero.ts`) is an uncalibrated placeholder.
- Launch weather for the launch-date picker, from Open-Meteo (`src/weather/launchWeather.ts`).

**Builder and import**
- Parts-based rocket builder with snapping, undo history, saved designs, challenges, a first-run tutorial, and a friendlier part-description layer.
- `.ork` import and export, RockSim import (`.rkt`, `.rse`), 3D model export (GLB, STL, OBJ), and share links (`src/io/`, `src/builder/`).
- Flaw analyzer with timestamps and a list of fixes; motor library with certified thrust curves.

**Cloud and server**
- Signed-in users save designs to Supabase (`src/cloud/designSync.ts`, `src/cloud/store.ts`). Schema and row-level security: `supabase/migrations/0001_cloud_data.sql`.
- The stress test runs on the server (`api/simulate.ts`: same-origin, rate limited, optional sign-in token). If the server call fails, the same code runs in the browser (`src/cloud/remoteSim.ts`).
- Research consent gates data collection (`src/cloud/consent.ts`).

**3D and UI**
- Three.js rendering: rocket meshes, launch complex, launcher staging and plume, orbit and trajectory lines, rotating Earth, solar system with time warp, force arrows. Planets are placed for the launch site's real sky (`eclipticToSiteWorld` and `gmstFromJd` in `src/world/ephemeris.ts`).
- Mission mode HUD with timeline scrubber, health panel, camera presets, and a mobile mission sheet. Unified UI tokens and 44 px touch targets.
- Landing page, hero, and a presentation (`presentation.html`, `ASTRA_Spaceflight_Presentation.pptx`).

**Accounts and platform**
- Supabase auth with a sign-in gate and a journey flow (`src/auth/`).
- Capacitor Android build with native save dialog.

**Last recorded checks** (23 Nov 2026): `npm run typecheck` clean; `tsc -p rocket-physics/tsconfig.json` clean; app tests 84 files, 1183 tests, all passing; `rocket-physics` tests (`npm test` in `rocket-physics/`) 45 suites, 280 tests, all passing; `npm run build` passing. Re-run `npm test` before relying on these numbers.

**Not done yet**
- Live deployment: the deploy script is ready, but no live URL is in the repo.
- Database-backed share links (`/r/<id>`) and a "My rockets" page.
- A compare-flights view.
- A lunar transfer view in the app. The Lambert solver and example are in `rocket-physics/`.
- Model accuracy: fin lift slope now matches OpenRocket's stored values within 3.6 % on three designs (fixed 23 Nov 2026). Still open: CG 4 to 9 mm forward of OpenRocket's and mass 2.6 % high on the simple rocket (see [docs/PLAN.md](docs/PLAN.md)).
- Transonic wave drag is an uncalibrated placeholder.
- A demo script was not found.

**Not verified:** whether the `supabase/migrations/` files are applied to the Supabase project; the app on a real phone (it runs on the Android 16 emulator as of 24 Nov 2026: sign-in gate, guest builder, Back button, update check); the 3D load time.

Plan, status and validation numbers: [docs/PLAN.md](docs/PLAN.md).

## Website

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # production site in dist/ (installable, works offline)
npm run deploy     # build, package for Vercel and deploy (needs the Vercel CLI, logged in and linked)
```

## Android app

Needs JDK 17 and the Android SDK. The app is the same web build inside a Capacitor WebView.

```
npm run android:apk
```

The debug APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r <path>` or copy it to the phone. `npm run android:sync` only rebuilds the web part and copies it into the Android project (then run it from Android Studio).

```
npm run android:release   # signed APK in release/ (to share directly)
npm run android:bundle    # signed AAB in release/ (for Google Play)
```

Both need a signing key in `android/keystore.properties`. The app version comes from `"version"` in `package.json`. Signing, the in-app update check, installing on a phone and publishing to Google Play or the App Store: [docs/MOBILE-RELEASE.md](docs/MOBILE-RELEASE.md).

## Data scripts

```
node scripts/fetch-data.mjs   # certified motor curves (ThrustCurve.org) + OpenRocket example designs for tests
node scripts/make-icons.mjs   # app icons for web and Android
```

OpenRocket's example files are GPL, so they are downloaded into `fixtures/external/` and not committed. Tests that need them skip when the folder is missing.

## Space imagery

Planet, Moon and Sun maps in `public/assets/space/` are the NASA-derived textures distributed with the three.js examples. The star catalogue, Milky Way outline and constellation lines are from d3-celestial (BSD-3-Clause). Press `C` in the map view to toggle constellation lines.
