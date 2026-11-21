// Compares our 6-DOF sim against the flight results OpenRocket stored inside an .ork file.
// Node-only: reads the file from disk.

import { cachedDeps } from '../physics/cache';
import { parseOrkFile } from '../ork/parser';
import { findMotor, thrustAt } from '../ork/motors';
import { embeddedMotors } from '../ork/rse';
import { extractSimulations, readOrkZip, type OrkSimulation } from '../ork/orkExtras';
import { atmosphere } from '../physics/atmosphere';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { createSim } from '../physics/sim';
import type { InnerTube, Motor, MotorRef, PhysicsDeps, SimConfig } from '../types';

// Variable specifier keeps the typecheck free of @types/node.
const NODE_FS = 'node:fs';
type NodeFs = { readFileSync(p: string): Uint8Array };

const MAX_SIM_TIME = 600; // s
const DT = 0.05; // s

export interface OursResult {
  maxAltitude: number;
  maxVelocity: number;
  timeToApogee: number;
  launchRodVelocity: number;
  flightTime: number;
  groundHitVelocity: number;
}

export interface ComparisonRow {
  sim: OrkSimulation;
  ours: OursResult | null;
  note?: string;
}

export async function compareWithOpenRocket(orkPath: string): Promise<ComparisonRow[]> {
  const fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as NodeFs;
  const bytes = fs.readFileSync(orkPath);

  const { xml, files } = await readOrkZip(bytes);
  const sims = extractSimulations(xml);

  // Motors the designer embedded in the archive (the exact ones flown) are searched before the database.
  const extraMotors: Motor[] = embeddedMotors(files);

  const deps: PhysicsDeps = cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt });
  const rows: ComparisonRow[] = [];

  for (const sim of sims) {
    rows.push(await runOne(bytes, sim, extraMotors, deps));
  }
  return rows;
}

async function runOne(
  bytes: Uint8Array,
  sim: OrkSimulation,
  extraMotors: Motor[],
  deps: PhysicsDeps,
): Promise<ComparisonRow> {
  if (!sim.motor) {
    return { sim, ours: null, note: 'no motor in simulation' };
  }

  const motor = findMotor({ manufacturer: sim.motor.manufacturer, designation: sim.motor.designation }, extraMotors);
  if (!motor) {
    return { sim, ours: null, note: 'motor not in database' };
  }
  const source = extraMotors.includes(motor) ? 'embedded' : 'database';
  const sourceNote = `motor from ${source}`;

  try {
    const rocket = await parseOrkFile(bytes);
    const mounts = rocket.components.filter(
      (c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount,
    );
    if (mounts.length === 0) {
      return { sim, ours: null, note: joinNotes(sourceNote, 'no motor mount in rocket') };
    }
    const multi = mounts.length > 1 ? `${mounts.length} motor mounts; only the first is set` : undefined;
    const note = multi ? joinNotes(sourceNote, multi) : sourceNote;

    const ref: MotorRef = {
      manufacturer: motor.manufacturer,
      designation: motor.designation,
      diameter: motor.diameter,
      length: motor.length,
      delay: sim.motor.delay,
    };
    mounts[0].motor = ref;

    const config: SimConfig = {
      railLength: sim.rodLength,
      railAngle: sim.rodAngle,
      railAzimuth: 0,
      windSpeed: sim.windSpeed,
      windDirection: Math.PI / 2,
      gust: 0,
      launchAltitude: 0,
      ejectionDelay: Number.isFinite(sim.motor.delay) ? sim.motor.delay : undefined,
    };

    const s = createSim(rocket, motor, config, deps);
    s.ignite();
    while (!s.done && s.state.t <= MAX_SIM_TIME) {
      s.step(DT);
    }

    const ours = summarise(s.log, s.events, s.state.t);
    if (!ours) {
      return { sim, ours: null, note: joinNotes(note, 'empty flight log') };
    }
    return { sim, ours, note };
  } catch (err) {
    return { sim, ours: null, note: `sim error: ${(err as Error).message}` };
  }
}

interface LogLike {
  altitude: number;
  speed: number;
}

interface EventLike {
  t: number;
  type: string;
  speed: number;
}

function summarise(log: LogLike[], events: EventLike[], endT: number): OursResult | null {
  if (log.length === 0) return null;

  let maxAltitude = -Infinity;
  let maxVelocity = -Infinity;
  for (const p of log) {
    if (p.altitude > maxAltitude) maxAltitude = p.altitude;
    if (p.speed > maxVelocity) maxVelocity = p.speed;
  }

  const first = (type: string): EventLike | undefined => events.find((e) => e.type === type);
  const apogee = first('apogee');
  const rail = first('railExit');
  const ground = first('landing') ?? first('crash');

  return {
    maxAltitude,
    maxVelocity,
    timeToApogee: apogee ? apogee.t : NaN,
    launchRodVelocity: rail ? rail.speed : NaN,
    flightTime: ground ? ground.t : endT,
    groundHitVelocity: ground ? ground.speed : NaN,
  };
}

function joinNotes(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}
