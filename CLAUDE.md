# ASTRA (space-flight-builder)

Rocket builder + 6-DOF spaceflight simulator: build or import (`.ork`, RockSim) a rocket, see it in 3D, fly it, get a flaw report; mission mode (LVM3, Falcon 9, PSLV) and lunar module. Vite + TypeScript + Three.js, Supabase (auth/Postgres), one Vercel serverless function, Capacitor Android wrapper of the same web build. Built for ASTRA 2026 hackathon. Windows dev machine (cmd/PowerShell).

## Layout
- `src/` app code: `app` (UI/loop), `builder`, `render`, `physics`, `mission`, `lunar`, `ork`, `io`, `cloud` (Supabase), `auth`, `world`, `weather`, `validate`, `landing`, `gallery`
- `rocket-physics/` standalone orbital-launch lib with own `package.json` + tests (Node >=23.6, `node --test`)
- `api/simulate.ts` Vercel function for the server-side stress test
- `supabase/migrations/` `0001_cloud_data.sql`, `0002_training_consent.sql`
- `android/` Capacitor project (appId `com.astra.spaceflightbuilder`); `scripts/` build/deploy/icons/data helpers
- `docs/` PLAN.md (plan + validation), PROGRESS.md (log), SYSTEM_DESIGN.md, others are per-task logs/prompts
- `public/` manifest + service worker + assets; root `*.html` are separate pages (index, landing, parts, presentation)
- Not part of the app (excluded in `.vercelignore`): `space-flight-godot/`, `astra-spaceflight (1)/` (reference site), `sentinel-hackathon/` (data/py scripts), `rocket-viewer/` (standalone viewer + samples), `*.txt`, `*.mp4`, `*.ppt(x)`, `screenshots/`

## Commands (repo root)
- Dev: `npm run dev` (http://localhost:5173) or `run-web.cmd`
- Typecheck: `npm run typecheck`; physics lib: `tsc -p rocket-physics/tsconfig.json`
- Tests: `npm test` (vitest, `src/**/*.test.ts`); physics: `cd rocket-physics && npm test`
- Build: `npm run build` (-> `dist/`, via `scripts/build-parallel.mjs`)
- Android: `npm run android:sync` (vite build + `cap sync android`); `npm run android:apk` (-> `android/app/build/outputs/apk/debug/app-debug.apk`); `android:release` / `android:bundle` via `scripts/android-release.mjs`
- `run-android.cmd`: sets JAVA_HOME `%LOCALAPPDATA%\Programs\jdk-17` and ANDROID_HOME `%LOCALAPPDATA%\Android\Sdk`, starts headless AVD `Android16` if no device, runs `android:sync`, `gradlew installDebug`, launches the app
- Data: `node scripts/fetch-data.mjs` (motor curves + OpenRocket fixtures into `fixtures/external/`, not committed; tests needing them skip), `node scripts/make-icons.mjs`

## Deploy
- `npm run deploy` = `npm run build && node scripts/build-vercel-output.mjs && vercel deploy --prebuilt --prod --yes` (needs Vercel CLI, logged in)
- Linked Vercel project: `astra-spaceflight` in team `ridhima20` (CLI login `panridhima07`; `.vercel/project.json`); `vercel.json` only adds security headers for Git-triggered builds (prebuilt deploys get them from `scripts/build-vercel-output.mjs`); live at https://astra-spaceflight.vercel.app
- Git remote `origin`: https://github.com/panridhima07/SpaceSim.git
- The Vercel project is git-connected to that repo: a push to `main` deploys to production, other branches get previews. Those Git builds have no Vercel env vars set (checked 2026-11-25) and replace whatever `npm run deploy` put live
- Previous project, no longer linked: `space-flight-simulater` (https://space-flight-simulater.vercel.app, team `medhanshkhattar05-8450s-projects`)

## Supabase
- Schema + RLS in `supabase/migrations/` (apply with `supabase db push`); tables: profiles, designs, rocket_files, import_corrections, sim_runs
- Env var names used in code: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (set in Vercel env for deploys; local values in gitignored env files)
- TODO(user): whether migrations are applied to the live Supabase project (README says unverified); no supabase/functions dir exists

## Rules
1. After any run that started a dev server, Android emulator, adb or gradle, stop those processes before finishing.
2. Never read or print `.env*` files.
3. Deploy to production only when the user asks.
4. Run `npm run typecheck` and `npm test` (plus rocket-physics tests if touched) before saying work is done.

## Gotchas
- `npm run deploy` goes straight to `--prod`; there is no preview step.
- `run-android.cmd` emulator runs `-no-window` (windowed mode hangs on this PC) and keeps running after the script; kill emulator/adb/gradle daemons afterward.
- Transonic aero (`src/physics/aero.ts`) is fitted to one OpenRocket flight to Mach 1.13 (ogive nose); other nose shapes' wave-drag factors are estimates. CG/mass still differ from OpenRocket (see docs/PLAN.md).
- Known not done: `/r/<id>` DB share links, "My rockets" page, compare-flights view (share links use URL hash).
