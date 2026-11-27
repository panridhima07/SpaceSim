# ASTRA — Rocket Builder & Spaceflight Simulator

Build a rocket, see it in 3D on a launch pad, fly it with a 6-DOF physics sim, and get a list of where and when the design fails. Import OpenRocket (`.ork`) designs or build from parts, fly real-vehicle missions (LVM3, Falcon 9, PSLV), and go on to the Moon. One codebase, two builds: a website and an Android app.

**Live:** https://astra-spaceflight.vercel.app

Judge demo guide: [docs/DEMO.md](docs/DEMO.md). Third-party licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Built for ASTRA 2026 (ANTERiX, VIT Bhopal). Plan and validation numbers: [docs/PLAN.md](docs/PLAN.md). Round-by-round log: [docs/PROGRESS.md](docs/PROGRESS.md).

## Goal

Turn this from a hackathon demo into a proper website and app for rocket building and simulation, **in 2 days**. The product loop is: **design a rocket, fly it, read the flaw report, tweak, refly.** Anyone can open a URL, build, simulate and share a design.

### 2-day plan

Status as of 26 Nov 2026. Only the deploy item is ticked: each other item bundles several parts, and the notes say which parts exist in code.

**Day 1: ship it and make it persistent**
- [x] Deploy the static build to a real URL (Vercel) and set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the host's environment
  - `npm run deploy` is ready. The folder is linked to a Vercel project (`.vercel/project.json`). The site is deployed on Vercel at https://astra-spaceflight.vercel.app (production deploy via `npm run deploy`, which runs `npm test` first).
- [ ] Real routes for landing, builder and simulator; PWA manifest and offline caching
  - Separate HTML pages (`index.html` app, `landing.html` Moon landing, `admin.html` usage dashboard, `parts.html` part gallery, `presentation.html` pitch deck). Manifest and service worker exist (`public/manifest.webmanifest`, `public/sw.js`).
- [ ] Supabase tables with row-level security: `rockets` (owner, name, design JSON, public flag) and `flights` (rocket, result summary)
  - `supabase/migrations/0001_cloud_data.sql` turns on row-level security for 5 tables: `profiles`, `designs`, `rocket_files`, `import_corrections`, `sim_runs`. There is no `rockets` or `flights` table. `0002_training_consent.sql` limits the team's training export to users whose consent is still on. `0003_usage_and_admin.sql` adds anonymous usage counts and the `admins` table. `0004_row_and_size_caps.sql` adds per-user row caps, size limits and a storage-path check (not yet applied). Whether 0001 to 0003 are applied to the live project is not verified (`supabase db push` applies them).
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
  - Not done: the site is deployed on Vercel at https://astra-spaceflight.vercel.app, but no demo run-through on it is recorded.

**Out of scope for the 2 days:** public gallery, leaderboards and server-side score validation. The backend is Supabase (auth, Postgres, storage) plus one small serverless function for the stress test (`api/simulate.ts`).

## What is done so far

**Physics and flight**
- `rocket-physics/`: orbital-launch library (6-DOF, RK4, ascent autopilot, guidance, staging, orbit and maneuver tools, fault monitoring) with its own Node tests. Vehicle definitions for LVM3, Falcon 9 and PSLV (`rocket-physics/src/vehicle/`).
- App wiring through `src/mission/`: engine re-exports, frame and attitude adapter, `flyMission` sampling to a shared `FlightRecord`, a worker plus in-thread fallback, mission snapshots and prediction.
- Missions (`src/mission/vehicles.ts`, `src/mission/missions/`): LVM3-M4 / Chandrayaan-3, PSLV-C61 / EOS-09 and Falcon 9 / Starlink, with failure injection, mission health and outcomes.
- Piloted mission flight: fly the mission by hand (`src/mission/pilot.ts`, `src/app/pilotControls.ts`).
- Lunar module: one continuous flight on the Moon page (`landing.html`, `src/lunar/`): the LVM3 launch from the pad at Sriharikota, Earth orbit, the coast to the Moon, lunar orbit, then the powered descent and landing. The lander and landing-site terrain are built ahead of time, so the hand-off from the journey to the live lander has no pause, and the mission clock keeps running. One Restart replays the whole flight from the pad; Retry landing goes back to the start of the powered descent. `?stage=descent` starts at the hand-off, for development.
- Hand-flown model-rocket flight: the parachute is manual only. Once the pilot has sent throttle or steering, the ejection charge and the automatic deploy settings are skipped and the pilot opens the chute with the stage control (Space, button "Chute"). Automatic runs (Launch, flaw report, sweeps, server stress test) still deploy by the rocket's deploy settings.
- Model-rocket sim: multi-stage `.ork` flight with stage separation and delayed upper-stage ignition (`src/ork/stageMotors.ts`; `src/ork/rh200.ts` is the RH-200 two-stage sample). Transonic and supersonic wave drag (`transonicWaveCd` in `src/physics/aero.ts`) is an uncalibrated placeholder.
- Launch weather for the launch-date picker, from Open-Meteo (`src/weather/launchWeather.ts`).

**Builder and import**
- Parts-based rocket builder with snapping, undo history, saved designs, challenges, a first-run tutorial, and a friendlier part-description layer.
- `.ork` import and export, RockSim import (`.rkt`, `.rse`), plus `.json`, `.eng` motor files and `.xml` (`src/io/importer.ts`), 3D model export (GLB, STL, OBJ), and share links (`src/io/`, `src/builder/`).
- Flaw analyzer with timestamps and a list of fixes; motor library with certified thrust curves.

**Cloud and server**
- Signed-in users save designs to Supabase (`src/cloud/designSync.ts`, `src/cloud/store.ts`). Schema and row-level security: `supabase/migrations/0001_cloud_data.sql`.
- The stress test runs on the server (`api/simulate.ts`: no CORS headers are sent (browsers on other sites cannot read the response); requests are rate limited per server instance and sign-in is optional). If the server call fails, the same code runs in the browser (`src/cloud/remoteSim.ts`).
- Research consent gates data collection (`src/cloud/consent.ts`).

**3D and UI**
- Three.js rendering: rocket meshes, launch complex, launcher staging and plume, orbit and trajectory lines, rotating Earth, solar system with time warp, force arrows. Planets are placed for the launch site's real sky (`eclipticToSiteWorld` and `gmstFromJd` in `src/world/ephemeris.ts`).
- Mission mode HUD with timeline scrubber, health panel, camera presets, and a mobile mission sheet. Unified UI tokens and 44 px touch targets.
- Landing page, hero, and a presentation (`presentation.html`, `ASTRA_Spaceflight_Presentation.pptx`). The landing-page mission cards are Chandrayaan-3, Starlink and EOS-09 (flyable) and the Starship booster catch (info card only, `src/auth/presets.ts`).

**Accounts and platform**
- Supabase auth with a sign-in gate and a journey flow (`src/auth/`). "Continue as guest" is remembered for the browser tab (sessionStorage `astra-guest`); if the Supabase env vars are missing, the app still opens in guest mode.
- CI: `.github/workflows/ci.yml` runs typecheck, tests, rocket-physics typecheck and tests, and the build on pushes to `main` and `app` and on pull requests.
- Security headers come from `scripts/build-vercel-output.mjs` (prebuilt deploys) and `vercel.json` (Git builds).
- Capacitor Android build with native save dialog.

**Last recorded checks** (23 Nov 2026; test counts updated 26 Nov 2026): `npm run typecheck` clean; `tsc -p rocket-physics/tsconfig.json` clean; app tests (vitest) 1,481+ tests in about 98 files, passing; `rocket-physics` tests (`npm test` in `rocket-physics/`) about 280 to 289 tests, passing; `npm run build` passing. Re-run `npm test` before relying on these numbers.

**Not done yet**
- Database-backed share links (`/r/<id>`) and a "My rockets" page.
- A compare-flights view.
- A lunar transfer view in the app. The Lambert solver and example are in `rocket-physics/`.
- Model accuracy: fin lift slope now matches OpenRocket's stored values within 3.6 % on three designs (fixed 23 Nov 2026). Still open: CG 4 to 9 mm forward of OpenRocket's and mass 2.6 % high on the simple rocket (see [docs/PLAN.md](docs/PLAN.md)).
- Transonic wave drag is an uncalibrated placeholder.

**Not verified:** whether the `supabase/migrations/` files are applied (0004 is known not applied) to the Supabase project; the app on a real phone (it runs on the Android 16 emulator as of 24 Nov 2026: sign-in gate, guest builder, Back button, update check); the 3D load time.

Plan, status and validation numbers: [docs/PLAN.md](docs/PLAN.md).

## Website

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # production site in dist/ (installable, works offline)
npm run deploy     # npm test, build, make-app-bundle, build-vercel-output, then vercel deploy --prebuilt --prod (needs the Vercel CLI, logged in and linked)
```

The site counts anonymous usage (app opens, flights, missions, imports) with no IP address, email or rocket data. The owner dashboard is at `/admin.html`, and only accounts in the `admins` table can see it. Setup is in the owner setup section of [docs/MOBILE-RELEASE.md](docs/MOBILE-RELEASE.md).

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

Web changes reach installed apps through website deploys, with no taps on the phone. APK updates are downloaded inside the app and opened with Android's installer. Details are in [docs/MOBILE-RELEASE.md](docs/MOBILE-RELEASE.md).

## Data scripts

```
node scripts/fetch-data.mjs   # certified motor curves (ThrustCurve.org) + OpenRocket example designs for tests
node scripts/make-icons.mjs   # app icons for web and Android
```

OpenRocket's example files are GPL, so they are downloaded into `fixtures/external/` and not committed. Tests that need them skip when the folder is missing.

## Space imagery

Planet, Moon and Sun maps in `public/assets/space/` are the NASA-derived textures distributed with the three.js examples. The star catalogue, Milky Way outline and constellation lines are from d3-celestial (BSD-3-Clause). Press `C` in the map view to toggle constellation lines.
