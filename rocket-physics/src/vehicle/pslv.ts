// ISRO's PSLV-XL (the "XL" PSLV configuration used for PSLV-C61 / EOS-09 in May 2025).
//
// Public figures, rounded, with sources in the comments. Anything not published is marked
// `// assumed`. The inert (dry) masses of the stages are NOT published by ISRO; they are
// assumed, and the PS1 and PS2 values were chosen so that the total liftoff mass matches the
// 320 t figure ISRO gives for the vehicle. They are not manufacturer data.
//
// Stage order (index in `stages`): 0 PS1 core, 1 strap-on group lit on the pad, 2 strap-on
// group lit in the air, 3 PS2, 4 PS3, 5 PS4.

import { DEG } from '../constants.ts';
import { solidReferenceThrust } from '../propulsion/engine.ts';
import type { VehicleSpec } from './types.ts';

// Thrust shapes (fraction of peak thrust versus time since ignition). The area under each
// curve is what matters for the total impulse; solidReferenceThrust scales the peak so the
// propellant mass and specific impulse come out exactly. The shapes are assumed, chosen so
// that the average-to-peak ratio matches the published peak thrust and burn time.

// PS1 S139: 110 s burn. Public peak 4846.9 kN, average from 138.2 t and Isp 269 s.
const S139_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 1],
  [20, 0.8],
  [60, 0.6],
  [100, 0.6],
  [108, 0.3],
  [110, 0],
];

// PSOM-XL strap-on: 70 s burn. Public peak 703.5 kN (one source says 719 kN).
const PSOM_XL_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.4, 1],
  [5, 1],
  [40, 0.6],
  [60, 0.5],
  [68, 0.25],
  [70, 0],
];

// PS3 S7: 126.7 s burn. Public peak 250 kN.
const S7_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.5, 0.9],
  [3, 1],
  [40, 0.8],
  [90, 0.6],
  [115, 0.45],
  [120, 0.25],
  [126.7, 0],
];

/**
 * The PSLV-XL with a payload of `payloadMass` kg (for PSLV-C61 this is the 1696.24 kg EOS-09
 * satellite, from ISRO's mission page). Liftoff mass comes out near 315 t against ISRO's 320 t.
 */
export function pslvXL(payloadMass: number): VehicleSpec {
  return {
    name: 'PSLV-XL',
    stages: [
      {
        // PS1: S139 solid core, lit on the pad. Propellant 138.2 t and burn 110 s (Wikipedia
        // PSLV page and PSLV-C61 article). Vacuum Isp 269 s, sea-level 237 s (same source).
        name: 'PS1 (S139)',
        dryMass: 25000, // assumed; calibrated so liftoff mass is near 320 t
        length: 19.0, // assumed
        radius: 1.4, // assumed (vehicle diameter 2.8 m is not confirmed)
        tanks: [{ name: 'HTPB', kind: 'solid', propellantMass: 138200, bottom: 0.5, length: 18, radius: 1.4, flowFraction: 1 }],
        engine: {
          name: 'S139',
          thrustVac: solidReferenceThrust(S139_CURVE, 138200, 269),
          ispVac: 269,
          ispSL: 237,
          maxGimbal: 4 * DEG, // assumed; the real core steers with a movable nozzle
          gimbalRate: 5 * DEG, // assumed
          thrustCurve: S139_CURVE,
        },
        engineCount: 1,
        residualFraction: 0,
        separationDelay: 1.64, // PS1 separation planned at T+111.64 s (Telangana Today)
        ignitionDelay: 0.2, // PS2 ignition planned 0.2 s after PS1 separation (111.84 s, same source)
        rcsTorque: 3000, // assumed
      },
      {
        // Six PSOM-XL strap-ons, four lit on the pad. Each booster: 12.2 t propellant
        // (Wikipedia PSLV page; one source says 12.0 t), burn 70 s, Vacuum Isp 262 s, peak 703.5 kN.
        // Inert mass 2.5 t is assumed (the standard PSOM is 2.01 t, per a search source).
        name: 'PSOM-XL (lit on pad)',
        dryMass: 2500, // assumed
        length: 13.5, // length 13.5 m from a search source (not checked against ISRO)
        radius: 0.5, // assumed
        tanks: [{ name: 'HTPB', kind: 'solid', propellantMass: 12200, bottom: 0.5, length: 12.5, radius: 0.5, flowFraction: 1 }],
        engine: {
          name: 'PSOM-XL',
          thrustVac: solidReferenceThrust(PSOM_XL_CURVE, 12200, 262),
          ispVac: 262,
          ispSL: 235, // assumed
          maxGimbal: 5 * DEG, // assumed
          gimbalRate: 5 * DEG, // assumed
          thrustCurve: PSOM_XL_CURVE,
        },
        engineCount: 1,
        residualFraction: 0,
        // Six boosters 60 degrees apart on the real vehicle. One ring of four cannot be evenly
        // spaced at 60 degrees, so the four pad-lit boosters sit on a 90 degree ring at 45, 135,
        // 225 and 315 degrees, and the two air-lit boosters take 0 and 180 degrees. All six are
        // at distinct positions; this is a drawing arrangement, not the real angles.
        parallel: { count: 4, radialOffset: 1.9, attachStation: 0.5, phase: Math.PI / 4 }, // radialOffset assumed (boosters touch the core)
        ignition: 'liftoff',
        separationDelay: 0.5, // assumed
      },
      {
        // Two PSOM-XL strap-ons lit about 25 s after liftoff (ISRO / Wikipedia launch profile).
        name: 'PSOM-XL (lit at T+25 s)',
        dryMass: 2500, // assumed
        length: 13.5,
        radius: 0.5,
        tanks: [{ name: 'HTPB', kind: 'solid', propellantMass: 12200, bottom: 0.5, length: 12.5, radius: 0.5, flowFraction: 1 }],
        engine: {
          name: 'PSOM-XL',
          thrustVac: solidReferenceThrust(PSOM_XL_CURVE, 12200, 262),
          ispVac: 262,
          ispSL: 235, // assumed
          maxGimbal: 5 * DEG, // assumed
          gimbalRate: 5 * DEG, // assumed
          thrustCurve: PSOM_XL_CURVE,
        },
        engineCount: 1,
        residualFraction: 0,
        parallel: { count: 2, radialOffset: 1.9, attachStation: 0.5, phase: 0 }, // radialOffset assumed
        ignition: { afterLiftoff: 25 },
        separationDelay: 0.5, // assumed
      },
      {
        // PS2: one Vikas engine, Earth-storable (UDMH / N2O4). Propellant 41.5 t (Wikipedia
        // text; the infobox says 41 t and another source 42 t), thrust 803.7 kN, vacuum Isp
        // 293 s, burn 151 s (Wikipedia). Inert mass assumed.
        name: 'PS2 (Vikas)',
        dryMass: 7000, // assumed; calibrated so liftoff mass is near 320 t
        length: 12.8, // assumed
        radius: 1.4, // assumed
        tanks: [
          { name: 'UDMH', propellantMass: 15385, bottom: 1.0, length: 4.0, flowFraction: 0.3707 }, // mixture split as LVM3 (assumed)
          { name: 'N2O4', propellantMass: 26115, bottom: 5.0, length: 6.5, flowFraction: 0.6293 },
        ],
        engine: { name: 'Vikas', thrustVac: 803.7e3, ispVac: 293, ispSL: 262, maxGimbal: 6 * DEG, gimbalRate: 15 * DEG, spoolTime: 1.5 },
        engineCount: 1,
        ignitionDelay: 0.2,
        separationDelay: 1.5, // PS2 separation planned at T+264.34 s (Telangana Today); assumed to follow burnout
        rcsTorque: 3000, // assumed
      },
      {
        // PS3: S7 solid upper stage. Propellant 7.6 t, peak 250 kN, Isp 295 s, burn 126.7 s
        // (Wikipedia PSLV page; Spaceflight101 gives an inert mass of 1.1 t).
        name: 'PS3 (S7)',
        dryMass: 1100, // Spaceflight101 inert mass for PS3
        length: 3.0, // assumed
        radius: 1.0, // assumed
        tanks: [{ name: 'HTPB', kind: 'solid', propellantMass: 7600, bottom: 0.3, length: 2.5, radius: 0.9, flowFraction: 1 }],
        engine: { name: 'S7', thrustVac: solidReferenceThrust(S7_CURVE, 7600, 295), ispVac: 295, maxGimbal: 0, thrustCurve: S7_CURVE },
        engineCount: 1,
        residualFraction: 0,
        ignitionDelay: 2.0, // assumed
        separationDelay: 1.0, // assumed
        rcsTorque: 300, // assumed
      },
      {
        // PS4: two storable engines (MMH / MON). Propellant 2.5 t (Skyrocket; the Wikipedia
        // table says 1.6 t, so this is the less certain figure). Each engine 7.4 kN, vacuum
        // Isp 308 s (Wikipedia PSLV page). Inert mass assumed.
        name: 'PS4 (2 x storable)',
        dryMass: 800, // assumed
        length: 2.5, // assumed
        radius: 1.0, // assumed
        tanks: [
          { name: 'MMH', propellantMass: 942.5, bottom: 0.4, length: 1.0, flowFraction: 0.377 }, // mixture ratio assumed
          { name: 'MON', propellantMass: 1557.5, bottom: 1.4, length: 1.0, flowFraction: 0.623 },
        ],
        engine: { name: 'PS4 engine', thrustVac: 7.4e3, ispVac: 308, exitArea: 0.1, maxGimbal: 0, ignitions: 1 }, // exitArea assumed
        engineCount: 2,
        ignitionDelay: 5, // assumed
        rcsTorque: 300, // assumed
      },
    ],
    payload: { mass: payloadMass, length: 1.5, radius: 1.0 }, // size assumed
    fairing: { mass: 1500, length: 7.0, radius: 1.6 }, // 3.2 m diameter (ISRO); mass and length assumed
  };
}
