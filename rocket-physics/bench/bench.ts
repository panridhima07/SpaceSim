// Speed benchmark. Run:  node bench/bench.ts
// Prints wall time for a few representative jobs, plus a fingerprint of each result so a
// change that makes the engine faster can be checked for not having changed the answer.

import {
  SITES,
  debrisImpacts,
  flyAscent,
  julianDate,
  lvm3,
  propagate,
  twoStageKerolox,
  RE,
  type Vec3,
} from '../src/index.ts';

declare const performance: { now(): number };

function bench(name: string, fn: () => string): void {
  const t0 = performance.now();
  const fingerprint = fn();
  const ms = performance.now() - t0;
  console.log(`${name.padEnd(34)} ${ms.toFixed(0).padStart(7)} ms   ${fingerprint}`);
}

const fp = (xs: number[]): string => xs.map((x) => x.toPrecision(12)).join(' ');

let twoStage: ReturnType<typeof flyAscent> | undefined;

bench('two-stage ascent + circularise', () => {
  twoStage = flyAscent(
    twoStageKerolox(12000),
    { site: SITES.sriharikota, epoch: new Date('2026-11-21T09:00:00Z') },
    {
      target: { perigeeAltitude: 200e3, apogeeAltitude: 600e3, compensateOblateness: true },
      pitchKickDeg: 6,
      maxG: 4.5,
      nodes: [{ name: 'Circularisation', at: 'apoapsis', deltaV: 'circularize' }],
    },
    9000,
  );
  const s = twoStage.sim;
  return fp([s.t, ...s.r, ...s.v, s.dvExpended]);
});

bench('debris impact prediction', () => {
  const d = debrisImpacts(twoStage!.sim);
  return fp(d.flatMap((x) => [x.latDeg, x.lonDeg, x.t]));
});

bench('LVM3 to GTO', () => {
  const res = flyAscent(
    lvm3(),
    { site: SITES.sriharikota, epoch: new Date('2023-07-14T09:05:17Z') },
    { target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 }, pitchKickDeg: 8 },
    3000,
  );
  const s = res.sim;
  return fp([s.t, ...s.r, ...s.v, s.dvExpended]);
});

bench('LEO propagation, 10 days', () => {
  const r: Vec3 = [RE + 400e3, 0, 0];
  const v: Vec3 = [0, 7668.6 * Math.cos(0.9), 7668.6 * Math.sin(0.9)];
  const out = propagate(r, v, 0, 10 * 86400, {
    epochJD: julianDate(new Date('2026-11-21T09:00:00Z')),
    drag: { cdAOverM: 0.01 },
    srp: { crAOverM: 0.01 },
  });
  return `${out.steps} steps  ` + fp([...out.r, ...out.v]);
});
