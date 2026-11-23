// Fly the same ascent many times with engine, mass, drag and wind scatter, and report how
// far the injection orbit spreads. Run:  node examples/dispersions.ts [runs] [seed]

import { SITES, runDispersions, twoStageKerolox, type Stat } from '../src/index.ts';

declare const process: { argv: string[] };
declare const performance: { now(): number };

const runs = Number(process.argv[2] ?? 40);
const seed = Number(process.argv[3] ?? 1);

const t0 = performance.now();
const res = runDispersions(
  () => twoStageKerolox(12000),
  { site: SITES.sriharikota, epoch: new Date('2026-11-21T09:00:00Z') },
  { target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3 }, pitchKickDeg: 6, maxG: 4.5 },
  { runs, seed, tMax: 1500 },
);
const seconds = (performance.now() - t0) / 1000;

const row = (name: string, s: Stat, scale: number, unit: string, digits = 1): string =>
  `${name.padEnd(20)} ${(s.mean / scale).toFixed(digits).padStart(9)} ${(s.std / scale).toFixed(digits).padStart(8)} ` +
  `${(s.p05 / scale).toFixed(digits).padStart(9)} ${(s.p95 / scale).toFixed(digits).padStart(9)}  ${unit}`;

console.log(`${runs} flights in ${seconds.toFixed(1)} s (${(seconds / runs).toFixed(2)} s each), seed ${seed}`);
console.log(`Reached the target orbit: ${(100 * res.successRate).toFixed(0)} %\n`);
console.log(`${''.padEnd(20)} ${'mean'.padStart(9)} ${'1-sigma'.padStart(8)} ${'5 %'.padStart(9)} ${'95 %'.padStart(9)}`);
console.log(row('Perigee', res.perigeeAltitude, 1000, 'km'));
console.log(row('Apogee', res.apogeeAltitude, 1000, 'km'));
console.log(row('Inclination', res.inclinationDeg, 1, 'deg', 3));
console.log(row('Propellant left', res.propellantMargin, 1, 'kg', 0));
console.log(row('Max Q', res.maxQ, 1000, 'kPa'));
console.log(row('Max g', res.maxG, 1, 'g', 2));
