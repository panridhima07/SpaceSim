# Space Flight Builder — Plan v4

**One line:** drop in an OpenRocket (`.ork`) file, see it in 3D on a launch pad, fly it with strong physics, and get a list of exactly where and when the design fails.

Built for ASTRA 2026 (ANTERiX, VIT Bhopal). v3 of this plan (Chandrayaan Flight Lab) cut the rocket builder and the solar system. v4 restores them as the core product and keeps the Chandrayaan work as a later mission mode on the same engine.

## What changed from v3

| v3 | v4 | Why |
|---|---|---|
| Godot, GDScript | TypeScript, Three.js, Vite, Vitest | `.ork` is zip + XML, which a browser reads natively. No export step, one language, unit tests run in seconds. |
| 2D replay of one mission | 3D flight of any user design | The goal is now design-flaw finding for student rocket teams. |
| Rocket builder cut | OpenRocket import replaces a builder | Teams already design in OpenRocket. We do not rebuild its editor; we fly its output. |
| Solar system cut | Solar system present, with time warp | Asked for. Kept cheap: analytic Kepler orbits, not n-body. |
| Score = difference from ISRO | Output = flaw report with time stamps | A concrete outcome judges can see. |

## The four pillars

### 1. `.ork` to 3D
- Read `.ork` (zip containing `rocket.ork` XML, or bare XML). Support nose cones (all OpenRocket shapes), body tubes, transitions, trapezoid / elliptical / freeform fin sets, inner tubes and motor mounts, parachutes, streamers, mass components, rings and bulkheads, mass and CG overrides.
- Unknown components are listed as warnings, never silently dropped.
- Mesh is generated from the same model the physics uses, so what you see is what is simulated. Cutaway view shows internals, CG and CP markers.
- **Added:** motors. `.ork` stores only a motor designation, not a thrust curve. Ship a small built-in motor table and accept RASP `.eng` files (from thrustcurve.org) by drag and drop. Built-in curves are marked approximate.

### 2. Launch platform inside a solar system, with time warp
- One frame for everything: Earth-centred, metres, 64-bit. Launch site sits at `(0, R_earth + alt, 0)`. Gravity is `-mu r / |r|^3`, so a suborbital hop and an orbit use the same code.
- Default site: Sriharikota (SDSC SHAR). This is the Domain 01 hook, see risks.
- Sun, eight planets and the Moon from JPL approximate Keplerian elements. Rendering uses a floating origin at the rocket and a logarithmic depth buffer.
- Time warp 1x to 100000x. In atmosphere or under thrust, warp is capped so the integrator step stays at 2 ms.

### 3. Fly it the way the real build would fly
- A model rocket is not steered, so "control" means what the team controls on launch day: rail length, rail angle and azimuth, wind speed, direction and gusts, motor choice, ejection delay, launch button.
- Optional active control for teams with a flight computer: thrust-vector gimbal on pitch and yaw. Off by default.
- Cameras: pad, chase, onboard, free.

### 4. Physics strong enough to find flaws
- 6-DOF rigid body, RK4, fixed 2 ms step, quaternion attitude.
- Mass, CG and inertia per component, changing as propellant burns.
- Aerodynamics by the Barrowman method (the same basis OpenRocket uses): normal-force slope and centre of pressure per component, body lift at angle of attack, pitch damping, drag from skin friction, base and pressure drag with a compressibility correction.
- ISA atmosphere to 86 km, wind with gusts, launch rail constraint, parachute deployment.
- **Flaw analyzer** (rule-based, no AI text). Each flaw has severity, the measured value, the limit, the time it happened and a fix:

| Flaw | Rule |
|---|---|
| Unstable | static margin below 1 calibre at any point in the burn |
| Over-stable | margin above about 3 calibres, weathercocks into wind |
| Slow off the rail | rail exit speed below 15 m/s or below 4x wind speed |
| Underpowered | thrust-to-weight below 5 at liftoff |
| Fin flutter | max speed above flutter speed estimate (NACA TN 4197 form) |
| Late or early ejection | speed at deployment above 20 m/s; delay vs time to apogee |
| Hard landing | descent rate above 6 m/s |
| Ballistic return | no recovery deployed before ground |
| High angle of attack | above 10 degrees while under thrust |
| Motor fit | motor diameter or length does not match the mount |
| Tumble | attitude rate runaway after burnout |

- The 3D view replays the flight and pauses at each flaw with the force arrows (thrust, drag, normal force at CP, weight at CG) drawn on the rocket.

## Visual style
Flat and minimal, in the spirit of mobile space-flight sims: solid colours, simple shapes, a sky gradient that fades to stars with altitude, a stylised two-cone flame, low-poly smoke puffs, thin white text on dark translucent panels, one accent colour. It is an original look inspired by the genre, not a copy of any one game's art.

## Existing work we reuse instead of writing

| Source | Licence | What we take |
|---|---|---|
| ThrustCurve.org API | public data | Certified motor thrust curves. `scripts/fetch-data.mjs` bundles a set for offline use; the app can also look up any motor by designation at runtime. Replaces hand-typed curves. |
| OpenRocket example `.ork` files | GPL | Real test inputs. Each file also stores OpenRocket's own simulation results (apogee, max speed, rail exit speed), so they are our validation targets for free. Downloaded by script into a git-ignored folder, not committed. |
| OpenRocket source | GPL | Reference for the file format and Barrowman details only. No code is copied, so the project is not bound to GPL. |
| three.js + examples | MIT | Renderer, OrbitControls, logarithmic depth buffer. |
| JSZip, xmldom | MIT | Reading the `.ork` zip and its XML. |
| astronomy-engine (npm) | MIT | Drop-in upgrade for planet positions if our Kepler approximation is not accurate enough. Not needed yet. |
| RocketPy | MIT | Second 6-DOF reference to cross-check against in phase 4. Python, so comparison only. |

## Honest limits (shown in the app, not hidden)
- Barrowman is valid for small angles and subsonic to low supersonic flight. Results above about Mach 1.5 or 15 degrees are flagged as low confidence.
- No structural FEA. Fin flutter and landing loads are estimates from rules of thumb.
- Earth does not rotate in v1. Fine for model rockets, wrong for orbital launch azimuths.
- OpenRocket files describe hobby rockets that reach hundreds of metres to a few kilometres. The planets are real and warp works, but no `.ork` design will reach them. Orbital flight needs a later "liquid stage" model.
- Validation target: apogee and max speed within 10 percent of OpenRocket's own simulation for three reference designs.

## Architecture

```
.ork / .eng  ->  ork/parser, ork/motors  ->  RocketModel + Motor   (src/types.ts is the contract)
RocketModel  ->  physics/massprops, physics/aero  ->  physics/sim (6-DOF)  ->  physics/flaws
RocketModel  ->  render/rocketMesh
world/ephemeris + world/solarSystem + world/clock  ->  scene
app/main: file drop, HUD, launch controls, flaw panel, replay
```

## Build phases

| Phase | Scope | Exit criterion |
|---|---|---|
| 1 (now) | Parser, motors, mass, aero, sim, flaws, mesh, world, each with unit tests | All module tests pass |
| 2 | App shell: drop file, see rocket on pad, launch, HUD, flaw panel | A sample `.ork` flies and lands in the browser |
| 3 | Replay with force arrows and flaw pause, charts, cutaway | Each flaw is clickable and jumps to its moment |
| 4 | Validation against OpenRocket on three designs | Within 10 percent |
| 5 | Chandrayaan mission mode from v3 (Horizons ghost, burn table) on the same solar system | Replay scrubs |
| 6 | Active control, multi-stage, Earth rotation | — |

## Status (23 Nov 2026)

Phases 1 and 2 are done and most of 3 and 4. Run with `npm install`, then `npm run dev`. `node scripts/fetch-data.mjs` re-downloads motor curves and the OpenRocket example files.

Working: `.ork` import (including the exact motors embedded in the file), 3D rocket with cutaway and CG/CP markers, launch pad, solar system with map view and time warp, 6-DOF flight with parachute recovery, flight log, pre-flight and post-flight flaw reports, replay scrubber with jump-to-flaw, 19-flight stress test (wind, rail angle, ejection delay), 20 certified motors plus runtime lookup. Multi-stage `.ork` flight with separation. Mission mode with LVM3, PSLV-C61 and Falcon 9 missions. Tests on 23 Nov 2026: app 1183 tests in 84 files pass; `rocket-physics` 280 tests in 45 suites pass.

Validation against OpenRocket's own stored results (same embedded motors), measured 23 Nov 2026:

| Quantity | A simple model rocket (5 flights) | Dual parachute deployment (6 flights) |
|---|---|---|
| Apogee | -4.4 % to +0.1 % | -5.4 % to -1.0 % |
| Max speed | -3.0 % to -2.2 % | -2.3 % to -0.2 % |
| Time to apogee | -1.1 % to +5.8 % (the +5.8 % flight has a too-short ejection delay) | -3.0 % to -0.8 % |
| Rail exit speed | -3.5 % to -1.1 % | -3.1 % to +0.6 % |

Static aerodynamics against the CNα, CP and stability that OpenRocket stores row by row in the same files (`src/validate/aeroOpenRocket.test.ts`, 1184 rows at Mach 0.05 to 0.3 and under 4 degrees angle of attack):

| Design | CNα | CP | Stability margin |
|---|---|---|---|
| A simple model rocket | within 2.9 % | within 0.05 cal | within 0.24 cal |
| Dual parachute deployment | within 3.6 % | within 0.14 cal | within 0.31 cal |
| Two stage high power rocket (before staging) | within 2.3 % | within 0.03 cal | not compared (test loads one motor only) |

What the validation test asserts (`src/validate/openrocket.test.ts`):
- "A simple model rocket": prints the comparison table and checks only that each flight gives a finite, positive apogee. It sets no error limit.
- "Dual parachute deployment": apogee within 8 %, max speed within 5 %, time to apogee within 5 %, rail exit speed within 6 % of OpenRocket.
- The two- and three-stage examples are not in the test.

Known gaps:
- Fixed 23 Nov 2026: fin lift slope (CNα) was 18 to 27 % below OpenRocket's. OpenRocket's stored CNα equals the Barrowman fin slope with the body-fin interference factor 1 + r/(s + r) applied twice, plus body lift K (A_planform / A_ref) sin(aoa) acting at the body planform centroid. Both are now modelled (`src/physics/aero.ts`, `src/physics/sim.ts`). The old margin looked close only because the low fin slope and the missing body-lift offset cancelled. The static margin the app shows (zero angle of attack) now reads 0.4 to 0.6 calibre higher than before; in flight, body lift pulls it back down, as in OpenRocket's stored data. "Over-stable" warnings (above about 3 calibres) therefore appear on more designs.
- The three-stage example still reads about 9 % low on CNα at 11 degrees angle of attack (freeform fins, high angle); not in the test.
- CG sits 4 to 9 mm forward of OpenRocket's on the two single-stage designs (0.16 to 0.18 calibre), which is most of the remaining margin difference.
- Error limits are asserted on one design only, the Dual parachute deployment. The simple model rocket is printed, not asserted. The two- and three-stage examples are not in the validation test.
- Dry mass is 3.4 % high on the reference design.
- Transonic and supersonic wave drag (`transonicWaveCd`) is an uncalibrated placeholder.

## Risks and open questions
- **Engine: decided.** One TypeScript codebase, two builds. The website is the Vite build (installable, works offline through a service worker). The mobile game is the same build inside a Capacitor Android app (`android/`), with a phone HUD: top telemetry strip, round Launch button, and a slide-up sheet for everything else. Godot is not used, so the physics is written and validated once.
- **Domain fit.** ASTRA Domain 01 is Indian space missions and data. A generic rocket tester is a weaker fit than v3 was. Mitigation: Sriharikota as the pad, an ISRO sounding rocket (RH-200) as a bundled sample, and phase 5. Confirm the domain rules.
- **Motor data.** Built-in thrust curves are approximations. Use certified `.eng` files for any real decision.
- **Still unverified from v3:** ASTRA deadline and judging criteria, delta-v table values, PRADAN terms.
