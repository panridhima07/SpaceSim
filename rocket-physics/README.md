# Astra rocket physics

A launch-to-orbit flight simulator core in TypeScript, with no dependencies. The vehicle is a six-degree-of-freedom rigid body with changing mass, flown in an Earth-centred inertial frame. The code flies an ascent from a launch site through staging, closed-loop guidance and orbit insertion, then runs coast and burn phases, orbital manoeuvres and debris impact prediction. It has no rendering: a game or visualiser drives the engine through its API and draws what it reports.

## Run it

You need Node 23.6 or later. Node runs the `.ts` files directly, so there is nothing to install.

```
npm test          # node --test over test/*.test.ts
npm run launch    # node examples/launch-to-orbit.ts
npm run lvm3      # node examples/lvm3-gto.ts
npm run moon      # node examples/lunar-transfer.ts
```

Trimmed output of `npm run launch` (two-stage rocket from Sriharikota to a 200 x 600 km transfer orbit, then a circularisation burn at apogee):

```
Events:
  T+    -2.3 s  Stage 1 ignition (9 x Merlin 1D class)
  T+     0.0 s  Liftoff, thrust-to-weight 1.36
  T+    11.5 s  Pitch-over
  T+    23.4 s  Gravity turn
  T+   118.7 s  Closed-loop guidance
  T+   145.6 s  Stage 1 burnout
  T+   148.6 s  Stage 1 separation
  T+   153.6 s  Stage 2 ignition (1 x Merlin Vacuum class)
  T+   164.4 s  Fairing jettison
  T+   513.8 s  Stage 2 cutoff
  T+   513.8 s  Orbit insertion: 200.0 x 618.3 km, inclination 13.63 deg
  T+  3294.5 s  Circularisation start: 107.6 m/s prograde
  T+  3297.8 s  Stage 2 cutoff
  T+  3297.8 s  Circularisation complete: 599.7 x 600.5 km, inclination 13.63 deg

Max Q        36.5 kPa at T+62 s, 11.0 km
Max g        4.50
Final orbit  599.2 x 601.1 km, inclination 13.63 deg
Target reached; 7723 kg usable propellant left
```

The insertion line reads 618 km, not 600, on purpose. Orbit figures at an instant are osculating elements: the ellipse the vehicle would follow if the Earth were a perfect sphere from then on. The Earth's equatorial bulge (J2) pulls harder than that, so the real apogee comes out about 18 km lower. This example sets `compensateOblateness: true`, which makes guidance aim for the apogee the vehicle will really reach. Without it, the cutoff meets 200 x 600 km in osculating elements and the vehicle tops out near 582 km.

`npm run lvm3` flies the LVM3 preset with the Chandrayaan-3 stack to its 170 x 36 500 km transfer orbit and compares the event times with the real flight of 14 July 2023:

```
Event                 simulated    actual flight
L110 ignition           108.0 s     108.1 s
S200 separation         126.7 s     127.0 s
Fairing separation      153.2 s     195.0 s
L110 separation         307.1 s     305.6 s
C25 ignition            309.5 s     308.0 s
C25 cutoff              935.7 s     954.4 s
```

The L110 ignition time is an input. The other times come out of the physics. The simulated cutoff is earlier because the model reaches the orbit with 963 kg of propellant left, about 22 s of burn. The fairing leaves early because the model uses only the heating criterion; the real vehicle keeps it longer.

`npm run moon` plans and flies a transfer from a 200 km parking orbit to a 100 km lunar orbit. Lambert's problem gives the injection burn. The path is then flown under the oblate Earth, the Moon and the Sun, and the aim point is corrected until closest approach is 100 km above the lunar surface:

```
TLI burn (Lambert):           3129.4 m/s   (Hohmann estimate to that distance: 3126.7 m/s)
First try, aimed at the Moon's centre: closest approach 6644 km from it
Corrected aim point:          7515 km from the Moon's centre, after 21 corrections
Arrival:                      T+4.379 days, perilune altitude 100.0 km
Lunar orbit insertion burn:   829.2 m/s retrograde -> circular at 1633 m/s
One day later:                altitude stays between 98.6 and 101.5 km above the Moon: captured
Total delta-v from LEO:       3959 m/s
```

The lunar example uses instantaneous burns on a point mass. The launch examples use the full six-degree-of-freedom vehicle.

The full report also has a telemetry table (one row per 20 s). The example then prints where each spent stage lands, using `debrisImpacts`.

## Use it from code

The examples import from `src/index.ts`, which re-exports the whole library. The two samples below run as written when placed at the repository root.

A complete ascent under the autopilot:

```ts
import { SITES, flyAscent, formatReport, twoStageKerolox } from './src/index.ts';

const result = flyAscent(
  twoStageKerolox(12000),
  { site: SITES.sriharikota },
  { target: { perigeeAltitude: 200e3 }, pitchKickDeg: 6 },
);
console.log(formatReport(result));
```

`flyAscent` returns a `FlightResult` with the `sim` object, the `autopilot`, and the final orbit. `result.reachedTarget` says whether the target was met.

A manual loop, the shape a game would use. Here the program sets the attitude and throttle itself, with no autopilot. It does not reach orbit. It shows how the calls fit together:

```ts
import { Simulation, SITES, twoStageKerolox, unit, type SimConfig } from './src/index.ts';

const cfg: SimConfig = { site: SITES.sriharikota, epoch: new Date('2026-11-21T09:00:00Z') };
const sim = new Simulation(twoStageKerolox(12000), cfg);

sim.stage();                          // light the liftoff engines
sim.cmd.throttle = 1;
while (sim.t < 20 && sim.diag.thrust <= 1.02 * sim.diag.mass * 9.80665) sim.step(0.02);
sim.release();                        // let go of the pad; sim.t is now the launch clock

const dt = 0.5;
while (!sim.ended && sim.missionTime < 300) {
  const d = sim.diag;
  sim.cmd.attitude = sim.missionTime < 10 ? d.up : unit(d.vRel);
  if (sim.rt.stages[0].burnedOut && sim.rt.stages[0].attached) sim.stage();
  sim.step(dt);
}
const tel = sim.telemetry();
console.log(`T+${tel.t - sim.liftoffTime} s  alt ${(tel.altitude / 1000).toFixed(1)} km  speed ${tel.speed.toFixed(0)} m/s  pitch ${tel.pitchDeg.toFixed(1)} deg  mass ${(tel.mass / 1000).toFixed(1)} t`);
```

Key calls:

- `sim.step(dt)` advances any amount of time. It splits the time into internal steps.
- `sim.cmd.attitude` is a unit vector in ECI for the nose, or `null` to hold no attitude command. `sim.cmd.throttle` is 0 to 1.
- `sim.diag` holds the current diagnostics: altitude, `vRel` (velocity relative to the air), `q`, `mach`, `thrust`, `mass`, `accelG` and more. It is refreshed after every internal step.
- `sim.telemetry()` returns one record: altitude, speed, apoapsis, periapsis, inclination and so on.
- `sim.events` is the event list, and `sim.log` is the telemetry log.

## Conventions

- **Units.** SI throughout: metres, seconds, kilograms, newtons, pascals. Angles are radians. Functions that take degrees say so in their names or comments.
- **ECI (Earth-centred inertial).** +Z is the Earth's spin axis. +X points at the vernal equinox. The dynamics are integrated in this frame (`src/env/earth.ts`).
- **ECEF (Earth-centred, Earth-fixed).** ECI rotated about +Z by the sidereal angle. The ground is at rest in this frame.
- **ENU (east, north, up).** The local frame at a point on the WGS-84 ellipsoid. `up` is the geodetic vertical, normal to the ellipsoid (`localFrame` in `src/env/earth.ts`).
- **Body axes.** +X points along the vehicle toward the nose. +Z points down-range, toward the belly, when the vehicle is pitched over. On the pad, +X is up and +Z points down-range.
- **Quaternions.** Stored as `[x, y, z, w]`. A quaternion rotates body vectors into the inertial frame. `qrot` and `qrotInv` apply it both ways (`src/math/vec.ts`).
- **Stations.** Positions along the vehicle are metres from the base of the part they belong to, positive toward the nose (`src/vehicle/types.ts`).
- **Time.** `sim.t` is seconds since the simulation started. `sim.liftoffTime` is when the vehicle left the pad, and `sim.missionTime` counts from there. `cfg.epoch` gives the calendar date, which sets Earth's orientation and the Sun and Moon positions. It defaults to J2000.
- **Y-up renderers.** The engine is Z-up. To draw in a Y-up renderer such as three.js, map engine (x, y, z) to renderer (x, z, -y).

## Physics modelled

Each row names the file that implements the idea. Files are relative to the repository root.

| Concept | What the model does | File |
| --- | --- | --- |
| Newton's laws, variable mass | Position and velocity change with the net force divided by the current mass. Mass falls as propellant burns. | `src/sim/simulation.ts` (`evaluate`) |
| Rocket equation | Ideal delta-v from Tsiolkovsky. Finite-burn duration for a given delta-v. | `src/orbit/maneuvers.ts` |
| Thrust with back-pressure | Thrust = throttle x vacuum thrust - ambient pressure x exit area. Mass flow depends only on throttle. | `src/propulsion/engine.ts` (`engineOutput`) |
| Sea-level and vacuum Isp | Vacuum Isp is the input. Sea-level Isp, when given, sets the exit area. Without either, the engine has no back-pressure loss. | `src/propulsion/engine.ts` (`exitArea`) |
| Ideal nozzle theory | From chamber pressure and temperature, the model gives c*, exit Mach from the area-Mach relation, exit pressure and velocity, and thrust coefficient. Used by `engineFromChamber`; the presets use plain numbers. | `src/propulsion/nozzle.ts` |
| Summerfield separation check | Flags a nozzle as separated when exit pressure is below 0.4 times ambient pressure. | `src/propulsion/nozzle.ts` (`at`) |
| Throttle limits and spool-up | Commands are clamped to `minThrottle` to 1. Actual throttle follows a first-order lag, time constant `spoolTime / 3`. | `src/sim/simulation.ts` (`updateThrottles`) |
| Solid motor thrust curves | Thrust follows a table of time against fraction of thrust. The reference thrust is scaled so the curve burns the loaded propellant. Solids cannot be throttled or stopped. | `src/propulsion/engine.ts`, `src/sim/simulation.ts` (`shutdown`) |
| Propellant tanks | Each tank has its own mass and drains at its share of the engine flow. Liquid tanks drain from the top of the column. | `src/vehicle/types.ts`, `src/sim/simulation.ts` (`checkBurnout`) |
| Mixture split and residuals | `flowFraction` splits engine flow between tanks. `residualFraction` (default 0.5 %) is never burned. The first tank to reach residual ends the burn. | `src/vehicle/types.ts`, `src/vehicle/massprops.ts` (`usablePropellant`) |
| Staging | A spent core stage is dropped after a separation delay. The next stage lights after an ignition delay. `stage()` does this by hand. | `src/gnc/autopilot.ts` (`sequence`), `src/sim/simulation.ts` (`stage`, `jettison`) |
| Strap-on boosters | Parallel stages, with a count and a radial offset. They burn with the core and drop when empty. | `src/vehicle/types.ts`, `src/vehicle/massprops.ts` |
| Air-lit core | A stage can light at a fixed time after liftoff, or after the stage below separates. | `src/gnc/autopilot.ts` (`sequence`) |
| Fairing jettison | The fairing is dropped above 80 km once free-molecular heat flux falls below 1135 W/m^2. | `src/gnc/autopilot.ts` (`sequence`) |
| Mass, CG and inertia in flight | Built from every attached part. Liquid columns shorten as they drain. Solid grains keep their length. Offset parts use the parallel-axis theorem. | `src/vehicle/massprops.ts` |
| CG continuity on separation | When a part is dropped, the body position is shifted so the centre of mass does not jump. | `src/sim/simulation.ts` (`afterMassChange`) |
| Euler's rigid-body equations | Angular acceleration from torque and inertia, including gyroscopic coupling and the rate of change of inertia. | `src/sim/simulation.ts` (`evaluate`) |
| Quaternion kinematics | Attitude is a unit quaternion, integrated from body rates and renormalised after each step. | `src/math/vec.ts` (`qderiv`, `qnormalize`) |
| Jet damping | Exhaust carries away angular momentum, which damps body rates. | `src/sim/simulation.ts` (`evaluate`) |
| Gravity-gradient torque | Torque from the difference in gravity across the length of the vehicle. | `src/sim/simulation.ts` (`evaluate`) |
| Thrust-vector control | Engines swivel to make pitch and yaw torque. Gimbal angle is limited by `maxGimbal`, and its rate by `gimbalRate`. | `src/sim/simulation.ts` (`control`) |
| Attitude control law | PD law on the attitude error, with a slew-limited reference. The current aerodynamic moment is fed forward and cancelled. | `src/sim/simulation.ts` (`control`) |
| Reaction-control thrusters | Provide roll torque, and pitch and yaw torque when the gimbal cannot. Limited by `rcsTorque`. | `src/sim/simulation.ts` (`control`) |
| Gravity | Point-mass inverse-square gravity, plus zonal J2, J3 and J4 harmonics (all on by default). | `src/env/gravity.ts` |
| Sun and Moon | Third-body accelerations from low-precision analytic positions. | `src/env/gravity.ts` (`thirdBodyAccel`), `src/env/ephemeris.ts` |
| WGS-84 ellipsoid | Equatorial radius, flattening, geodetic latitude and altitude, and the ENU frame. | `src/constants.ts`, `src/env/earth.ts` |
| Earth rotation | Greenwich sidereal time from the IAU 1982 formula. The ground moves with the rotation, so Coriolis effects and the eastward launch bonus come from the ECI integration. | `src/env/earth.ts` (`gmst`, `groundVelocity`) |
| Atmosphere | US Standard Atmosphere 1976 layer equations up to 86 km. Exponential density fit from 86 km to 1000 km. Vacuum above 1000 km. | `src/env/atmosphere.ts` |
| Wind and jet stream | Surface wind with a 1/7 power law, plus a Gaussian jet stream near 11 km. Drag uses air-relative velocity. | `src/env/atmosphere.ts` (`jetStreamWind`) |
| Drag | Zero-lift drag coefficient from a table against Mach number, referenced to frontal area. | `src/aero/aero.ts` (`interpolate`, `aeroForces`) |
| Normal force and centre of pressure | Potential lift on the nose and each booster, plus cross-flow lift on the body. Centre of pressure is reported. | `src/aero/aero.ts` (`aeroForces`) |
| Pitch and yaw damping | Moment proportional to body rate, from the local cross-flow. | `src/aero/aero.ts` (`aeroForces`) |
| Free-molecular blend | The drag coefficient blends from the continuum table to 2.2 across the Knudsen number range 0.01 to 10. | `src/aero/aero.ts` (`aeroForces`) |
| Dynamic pressure and max Q | q = rho V^2 / 2, tracked as the flight runs. | `src/aero/aero.ts`, `src/sim/simulation.ts` (`bookkeeping`) |
| Aerodynamic heating | Sutton-Graves stagnation heat flux, integrated over the flight as heat load. Free-molecular heat flux is computed separately. | `src/aero/aero.ts` |
| Hold-down and release | The vehicle is clamped on the pad until thrust exceeds 1.02 times weight with engines near full throttle. Release sets the liftoff time. | `src/sim/simulation.ts` (`release`), `src/gnc/autopilot.ts` |
| Gravity turn | The nose follows the air-relative velocity, so angle of attack stays near zero. | `src/gnc/autopilot.ts` |
| Closed-loop guidance | Linear-tangent steering, tan(pitch) = k1 + k2 t. Solved by prediction and Newton correction. Re-solved twice a second and at every change of thrust schedule. | `src/gnc/guidance.ts`, `src/gnc/autopilot.ts` |
| Oblateness-compensated targeting | Optional. Finds the cutoff speed whose far apsis, flown under the real gravity field, lands at the requested altitude. | `src/gnc/autopilot.ts` (`speedForFarApsis`) |
| Yaw steering | Out-of-plane position and velocity are driven to zero by cutoff. | `src/gnc/autopilot.ts` (`closedLoop`) |
| Launch azimuth | Inertial azimuth from sin(beta) = cos(i) / cos(lat), then corrected for the pad's eastward speed. | `src/orbit/maneuvers.ts` (`launchAzimuth`) |
| g-limit and max-Q throttling | Throttle is reduced to hold on-board acceleration and dynamic pressure near their limits. The g-limit leads the engine lag, because mass keeps falling while the engines respond. | `src/gnc/autopilot.ts` (`throttle`) |
| Orbital elements | State to classical elements and back. Kepler's equation solved by Newton's method with a bisection fallback. | `src/orbit/kepler.ts` |
| Universal-variable propagation | Two-body propagation for ellipses, parabolas and hyperbolas, using Stumpff functions and Lagrange coefficients. | `src/orbit/kepler.ts` (`propagateKepler`) |
| Lambert's problem | Single-revolution transfer between two positions in a given time, solved by bisection on the universal variable. | `src/orbit/lambert.ts` |
| Hohmann and bi-elliptic transfers | Two-burn and three-burn coplanar transfers. | `src/orbit/maneuvers.ts` |
| Plane change | Pure plane change, and plane change combined with a speed change. | `src/orbit/maneuvers.ts` |
| Sphere of influence | Radius a (mu_small / mu_big)^(2/5), where mu is each body's gravitational parameter. | `src/orbit/maneuvers.ts` |
| J2 precession | Secular nodal and apsidal rates. Sun-synchronous inclination for a given altitude. | `src/orbit/maneuvers.ts` |
| Numerical integration | Dormand-Prince 5(4) with error control for coasts and orbits. Classical fixed-step RK4 for powered flight. | `src/math/integrators.ts` |
| Orbit propagation | Numerical propagation with gravity, third bodies, drag, solar radiation pressure and the Earth's cylindrical shadow. | `src/orbit/propagate.ts` |
| Debris impact | Spent stages fall ballistically with drag until they reach the ground. The impact latitude and longitude are reported. | `src/orbit/propagate.ts` (`propagateToImpact`), `src/sim/report.ts` (`debrisImpacts`) |
| Pitch-kick optimisation | Samples, then golden-section search on the pitch kick. The score favours reaching orbit with propellant left over. | `src/sim/report.ts` (`tunePitchKick`) |

## How a flight runs

The ascent autopilot (`src/gnc/autopilot.ts`) moves through these phases:

1. **prelaunch.** The liftoff stages light. The vehicle stays clamped until thrust exceeds 1.02 times weight, then releases. If thrust never reaches that level within 15 s, the launch aborts.
2. **vertical.** The nose points straight up until vertical speed reaches 50 m/s.
3. **pitchover.** The nose tilts toward the launch azimuth at 1 degree per second, up to the programmed kick (`pitchKickDeg`, default 3).
4. **gravityTurn.** The nose follows the air-relative velocity. This holds until the boosters are gone, dynamic pressure is below 1000 Pa, and altitude is above 40 km.
5. **closedLoop.** Linear-tangent guidance steers for the target perigee and apogee, across staging. Yaw steering drives the orbit into the target plane. Cutoff comes when the angular momentum reaches the target.
6. **coast.** After insertion, the vehicle coasts until the next manoeuvre node. With no nodes it skips straight to `done`.
7. **burn.** The vehicle fires for one manoeuvre node, pointed prograde, retrograde, normal, radial or along a fixed vector.
8. **done.** The nose follows the velocity. `flyAscent` stops here. If propellant runs out before the target is reached, `reachedTarget` is false and the autopilot still moves on to `coast` and then `done`.

Time stepping has two modes:

- **Powered and in the atmosphere.** The state is integrated with fixed-step RK4 at `dt` (default 0.02 s). The attitude controller runs at each step.
- **On the pad.** The vehicle is clamped to the rotating Earth. Only throttle and propellant advance.
- **Unpowered above `coastAltitude`.** When no engine burns and altitude is above `coastAltitude` (default 150 km), only translation is integrated. An adaptive Dormand-Prince solver takes steps up to 60 s. The step is shortened if a descending vehicle could skip the atmosphere. If an attitude command is set, it is applied directly in this mode.

## Vehicles

`src/vehicle/presets.ts` has two reference vehicles. The figures are rounded public numbers, not manufacturer data. The file's header says they reproduce the real vehicles' performance to within several per cent.

| Vehicle | Stage | Propellant (kg) | Engine | Vacuum thrust | Vacuum Isp (s) |
| --- | --- | --- | --- | --- | --- |
| `twoStageKerolox(payload = 15000)` | Stage 1 | 395,700 | 9 x Merlin 1D class | 914 kN each | 311 |
| | Stage 2 | 107,500 | 1 x Merlin Vacuum class | 934 kN | 348 |
| `lvm3(payload = 3900)` | L110 core | 110,500 | 2 x Vikas | 799 kN each | 293 |
| | S200 boosters | 205,000 each, 2 boosters | 1 x S200 per booster | about 5575 kN each | 274.5 |
| | C25 | 28,000 | 1 x CE-20 | 186.4 kN | 442 |

The S200 thrust is not typed in. It is computed from the thrust curve and the propellant mass.

A minimal custom vehicle. Field names are from `src/vehicle/types.ts`. This one stage cannot reach orbit, but it runs:

```ts
import { Simulation, SITES, type VehicleSpec } from './src/index.ts';

const toyRocket: VehicleSpec = {
  name: 'Toy single stage',
  stages: [
    {
      name: 'Stage 1',
      dryMass: 2000,
      length: 10,
      radius: 1,
      tanks: [{ propellantMass: 20000, bottom: 1, length: 7, flowFraction: 1 }],
      engine: { name: 'Engine A', thrustVac: 300e3, ispVac: 300 },
      engineCount: 1,
    },
  ],
  payload: { mass: 500, length: 2 },
};

const sim = new Simulation(toyRocket, { site: SITES.sriharikota });
```

Optional fields include `fairing`, `aero` (drag table, nose lift slope, nose radius), `ignition`, `separationDelay`, `ignitionDelay`, `rcsTorque`, `residualFraction`, and on engines `minThrottle`, `maxGimbal`, `gimbalRate`, `spoolTime`, `ignitions` and `thrustCurve`.

## Validation

The test suite checks the models against published or analytic reference values, and checks identities that must hold exactly. `npm test` runs 200 tests in seven files in about 30 s, and all pass.

- `test/env.test.ts`. US Standard Atmosphere 1976 table values from sea level to 400 km. Density falls with altitude and is continuous across the 86 to 90 km blend. Gravity equals the numerical gradient of the potential. WGS-84 round trips and the ground speed at the equator. Sidereal time at J2000. Sun position at the equinox and solstice. The Moon position against Meeus example 47.a.
- `test/orbit.test.ts`. Curtis examples 4.3 (state to elements) and 5.2 (Lambert). Elements round trips for elliptic, hyperbolic and equatorial orbits. Kepler's equation residuals. Lambert transfers. Hohmann from LEO to GEO. Bi-elliptic against Hohmann. Sun-synchronous inclination at 800 km. ISS nodal precession. The critical inclination where apsidal precession vanishes. Launch azimuth.
- `test/propulsion.test.ts`. Area-Mach values for gamma 1.4 (Mach 2 gives 1.6875). Exit conditions and c* against reference values. Vacuum thrust and Isp ranges. Sea-level thrust lower by exactly P0 times exit area. Summerfield separation at sea level. Solid thrust curve integrates to the loaded propellant.
- `test/vehicle.test.ts`. Mass and CG against hand calculations. Parallel-axis check on the inertia. Liquid columns shorten as they drain, and solid grains keep their CG. Booster symmetry in the inertia. Usable propellant and the Tsiolkovsky budget. Aerodynamic signs for drag, lift, pitch damping and yaw damping. Free-molecular drag limit. Sutton-Graves against a classic value.
- `test/propagate.test.ts`. Circular orbit closes after one period. Energy conservation over ten orbits at default tolerances. J2 nodal regression within 3 per cent of the analytic rate. Forward and backward propagation return to the start. Drag lowers energy. Shadow test. Solar radiation pressure changes a GEO orbit by a small, bounded amount. Ballistic impact from a drop.
- `test/guidance.test.ts`. Thrust schedule integrals. The predictor against free fall and a circular coast. The steering solver hits the target radius, radial speed and angular momentum for one stage and across a staging gap, warm-starts in two iterations, and reports an unreachable target.
- `test/sim.test.ts`. Whole flights. The pad moves with the Earth. Sea-level thrust on the pad. The two-stage rocket reaches 200 km within 3 km with the events in order, max Q between 8 and 16 km, the g-limit held, angle of attack under 3 degrees in dense air, and mass accounted for to the kilogram. One further orbit stays up. The circularisation burn. LVM3 reaches 170 x 36 500 km with event times near the real flight. An overloaded rocket fails cleanly and a grossly overloaded one aborts on the pad. Manual flight, wind, determinism, pitch-kick tuning, stage impact points, and oblateness-compensated targeting.

## Limits

These are not modelled. Each is a real gap in the code.

- No propellant slosh, and no structural bending of the airframe.
- Aerodynamics are a slender-body engineering model: a drag table against Mach, and a constant nose normal-force slope. This is not CFD or wind-tunnel data.
- The atmosphere is a mean. There is no weather and no solar-cycle variation. Orbit lifetime estimates are rough.
- Earth gravity goes to J4 only. There are no tesseral (longitude-dependent) terms.
- No precession, nutation or polar motion. The Sun and Moon come from low-precision series. The Moon is good to about 0.3 degrees in longitude.
- During unpowered coast above the atmosphere, attitude is held perfectly. Only translation is integrated there.
- Engine shutdown is instantaneous.
- Roll control comes only from the reaction-control thrusters.
- Guidance predicts the in-plane motion with vacuum thrust. It does not model the g-limit throttle, so the real vehicle can differ from the prediction near the limit.
- The vehicle presets are approximate.
- No reentry heat shield, parachutes or landing. A flight ends at ground impact.
- No relativistic effects.
- The frame is Earth-centred only. There are no heliocentric or planet-centred flight phases. Lunar gravity is included as a perturbation, not as a destination frame.
