# ASTRA demo guide for judges

## What it is

ASTRA is a rocket builder and spaceflight simulator that runs in the browser (and as an Android app). You build a rocket from parts or import an OpenRocket (`.ork`) design, see it in 3D on a launch pad, fly it with a 6-DOF physics sim, and get a flaw report that says where and when the design fails. It also flies real-vehicle missions (ISRO's LVM3, PSLV, Falcon 9) and has a lunar landing mode. Live site: https://astra-spaceflight.vercel.app

No account is needed. On the sign-in screen choose "Continue as guest" (designs then stay in this browser).

## 3-minute demo path

Start on the title screen after "Continue as guest". It has four buttons: BUILD A ROCKET, TRY THE SAMPLE ROCKET, MOON LANDING, FLY ISRO'S LVM3.

1. **Sample rocket (about 30 s).** Press TRY THE SAMPLE ROCKET. Look for the 3D rocket on the pad. Press **Launch** (or Space) in the launch panel. Look for the flight playing out and the post-flight numbers (apogee, rail exit speed, landing speed). **Reset** (or R) puts it back on the pad. Camera presets are in the HUD. (Exact camera button names: not verified.)
2. **Break it on purpose (about 60 s).** Press **Build Rocket** (BUILD A ROCKET on the title screen). Select a fin and shrink it (or move the fins up the body) until the stability readout drops. The builder labels a stability margin under 1 calibre as "Unstable". Press **Launch** and read the flaw report. Look for a flaw titled "Unstable: CP ahead of CG" or "Unstable: stability margin under 1 calibre", with a timestamp and suggested fix. The report can also show "Rail exit speed too low", "Fin flutter", "High angle of attack under thrust", "Hard landing". (The exact fin fields to edit in the builder: not verified; the stability label and flaw titles are in code.)
3. **Stress test (about 30 s).** Back in the main view press **Stress test**. It flies a batch of headless flights over wind, rail angle and ejection delay (README says 19 flights) and shows a table with apogee, rail exit speed, drift and landing speed. A toast says whether it ran "on our server" or "on this device" (the browser fallback).
4. **Fly ISRO's LVM3 (about 60 s).** From the title screen press FLY ISRO'S LVM3. This opens mission mode for LVM3-M4 / Chandrayaan-3 from Sriharikota. Look for the HUD, health panel, timeline scrubber and camera presets. Press **Fly manually** if you want to pilot it. Missions marked "flyable" in the mission list: Chandrayaan-3, Starlink delivery (Falcon 9), EOS-09 (PSLV). "Booster catch" is a brief only and is not flyable.
5. **Moon landing (about 20 s).** Press MOON LANDING (or **Moon landing** in the builder side panel). It opens `landing.html` with the lunar cruise, terrain and lander. What the controls and scoring are: not verified here.

Extras if there is time: **Import file** (accepts `.ork`, `.rkt`, `.json`, `.eng`, `.rse`) and **Export .ork** in the builder panel.

## What's under the hood

- 6-DOF flight simulation with RK4 integration, parachute recovery, stage separation and wind. Mission flights use a separate orbital-launch library (`rocket-physics/`) with ascent guidance, staging, orbit and maneuver tools, and failure injection.
- OpenRocket `.ork` import and export (including the motors embedded in the file), plus RockSim import and GLB/STL/OBJ model export.
- Validation against OpenRocket's own stored results, target within 10 %: Design 1 (simple model rocket) apogee -4.4 % to +0.1 %; Design 2 (dual parachute deployment) apogee about -5.4 % to -1.0 %. Max speed within about 3 % on both. Static fin lift (CNα) within 3.6 % on three designs.
- Flaw analyzer with timestamps, a replay scrubber that jumps to each flaw, and a pre-flight and post-flight report.
- Tests: 1,481 app tests in 98 files (vitest) and 280 physics tests (`node --test`), all passing on 26 Nov 2026. Re-run `npm test` before a demo to confirm.
- Android app: the same web build in a Capacitor WebView, with a native save dialog and an in-app update check.
- Supabase accounts: sign-in and cloud-saved designs with row-level security. Data collection for research is gated behind a consent setting.
- The stress test runs on one Vercel serverless function (`api/simulate.ts`) and falls back to the browser if the call fails.

## Known limitations

- Transonic and supersonic wave drag is an uncalibrated placeholder, so flights near Mach 1 are less trustworthy.
- CG sits 4 to 9 mm forward of OpenRocket's and dry mass is about 3 % high on the reference design.
- Error limits are asserted in tests on one design only (Dual parachute deployment); the simple rocket is printed, not asserted. The two- and three-stage examples are not in the validation test.
- The validation tests need OpenRocket example files and motor curves downloaded with `node scripts/fetch-data.mjs`. Without them those tests skip.
- The Android app has been run on the Android 16 emulator only, not on a real phone.
- Share links carry the design in the URL hash. There are no database-backed `/r/<id>` links and no "My rockets" page.
- There is no compare-flights view.
- Whether the Supabase migrations are applied to the live project is not verified.
