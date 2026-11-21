// Launch a two-stage rocket from Sriharikota into a 200 x 600 km transfer orbit, coast
// to apogee and circularise. Run:  node examples/launch-to-orbit.ts

import { SITES, debrisImpacts, flyAscent, formatReport, twoStageKerolox } from '../src/index.ts';

declare const process: { argv: string[] };

const result = flyAscent(
  twoStageKerolox(12000),
  { site: SITES.sriharikota, epoch: new Date('2026-11-21T09:00:00Z') },
  {
    // compensateOblateness: aim for a true 600 km apogee. Without it the cutoff meets 200 x 600 km
    // in instantaneous Keplerian elements and the Earth's bulge then lowers the real apogee to about 582 km.
    target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3, compensateOblateness: true },
    pitchKickDeg: Number(process.argv[2] ?? 6),
    maxG: 4.5,
    nodes: [{ name: 'Circularisation', at: 'apoapsis', deltaV: 'circularize' }],
  },
  9000,
);

console.log(formatReport(result));
console.log('\nSpent hardware comes down at:');
for (const d of debrisImpacts(result.sim)) {
  console.log(`  ${d.name.padEnd(10)} ${d.latDeg.toFixed(2)} N, ${d.lonDeg.toFixed(2)} E  (T+${(d.t - result.sim.liftoffTime).toFixed(0)} s)`);
}
