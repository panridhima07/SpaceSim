// Fly ISRO's LVM3 from Sriharikota with the Chandrayaan-3 stack to its 170 x 36 500 km
// transfer orbit, and compare the timeline with the real flight of 14 July 2023.
// Run:  node examples/lvm3-gto.ts [pitchKickDeg]

import { SITES, debrisImpacts, flyAscent, formatReport, lvm3 } from '../src/index.ts';

declare const process: { argv: string[] };

const result = flyAscent(
  lvm3(),
  { site: SITES.sriharikota, epoch: new Date('2023-07-14T09:05:17Z') },
  { target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 }, pitchKickDeg: Number(process.argv[2] ?? 8) },
  3000,
);
const sim = result.sim;
console.log(formatReport(result, 30));

// Published LVM3-M4 / Chandrayaan-3 flight events, seconds after liftoff.
const actual: [string, RegExp, number][] = [
  ['L110 ignition', /L110 core ignition/, 108.1],
  ['S200 separation', /S200 boosters separation/, 127.0],
  ['Fairing separation', /Fairing jettison/, 194.96],
  ['L110 separation', /L110 core separation/, 305.56],
  ['C25 ignition', /C25 cryogenic stage ignition/, 307.96],
  ['C25 cutoff', /C25 cryogenic stage cutoff/, 954.42],
];
console.log('\nEvent                 simulated    actual flight');
for (const [name, pattern, t] of actual) {
  const e = sim.events.find((x) => pattern.test(x.message));
  console.log(`${name.padEnd(20)} ${(e ? (e.t - sim.liftoffTime).toFixed(1) : '   -').padStart(8)} s  ${t.toFixed(1).padStart(8)} s`);
}

console.log('\nSpent hardware comes down at:');
for (const d of debrisImpacts(sim)) {
  console.log(`  ${d.name.padEnd(14)} ${d.latDeg.toFixed(2)} N, ${d.lonDeg.toFixed(2)} E  (T+${(d.t - sim.liftoffTime).toFixed(0)} s)`);
}
