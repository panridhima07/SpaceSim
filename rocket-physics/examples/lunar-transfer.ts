// From low Earth orbit to low lunar orbit.
//
//   1. Start in a 200 km parking orbit in the plane of the Moon's motion.
//   2. Solve Lambert's problem for a trans-lunar injection (TLI) burn that arrives
//      near where the Moon will be several days later, and pick the cheapest departure point.
//   3. Fly it under the full force model: oblate Earth, Moon and Sun. Lambert ignored
//      the Moon's pull, so the first try misses; correct the aim point until the
//      closest approach is 100 km above the lunar surface.
//   4. Brake into a circular lunar orbit at closest approach and confirm it stays captured.
//
// Run:  node examples/lunar-transfer.ts [flightDays]

import {
  MU_EARTH,
  MU_MOON,
  RE,
  R_MOON,
  add,
  circularVelocity,
  cross,
  dot,
  hohmann,
  julianDate,
  lambert,
  moonPosition,
  moonVelocity,
  norm,
  propagate,
  scale,
  sub,
  unit,
  type ForceModel,
  type Vec3,
} from '../src/index.ts';

declare const process: { argv: string[] };

const epoch = new Date('2023-08-01T00:00:00Z');
const epochJD = julianDate(epoch);
const fm: ForceModel = { epochJD };
const tof = Number(process.argv[2] ?? 4.5) * 86400;
const moonAt = (t: number): Vec3 => moonPosition(epochJD + t / 86400);
const moonVelAt = (t: number): Vec3 => moonVelocity(epochJD + t / 86400);

// --- 1. Parking orbit in the Moon's orbital plane ---------------------------------------
const rPark = RE + 200e3;
const vPark = circularVelocity(rPark);
const rMoonArr = moonAt(tof);
const normal = unit(cross(rMoonArr, moonVelAt(tof)));
const e1 = unit(rMoonArr);
const e2 = cross(normal, e1);
const parking = (phi: number): { r: Vec3; v: Vec3 } => ({
  r: add(scale(e1, rPark * Math.cos(phi)), scale(e2, rPark * Math.sin(phi))),
  v: add(scale(e1, -vPark * Math.sin(phi)), scale(e2, vPark * Math.cos(phi))),
});

// --- 2. Lambert targeting -----------------------------------------------------------------
/** TLI from parking-orbit angle phi to an aim point displaced by `offset` from the Moon's centre. */
function tli(phi: number, offset: Vec3): { r: Vec3; v: Vec3; dv: number } {
  const p = parking(phi);
  const aim = add(rMoonArr, offset);
  const { v1 } = lambert(p.r, aim, tof, MU_EARTH, { normal });
  return { r: p.r, v: v1, dv: norm(sub(v1, p.v)) };
}
const ZERO: Vec3 = [0, 0, 0];
// Cheapest departure point: scan the orbit, then refine.
let best = { phi: 0, dv: Infinity };
for (let k = 0; k < 720; k++) {
  const phi = (k / 720) * 2 * Math.PI;
  try {
    const dv = tli(phi, ZERO).dv;
    if (dv < best.dv) best = { phi, dv };
  } catch {
    // transfer angle of exactly 0 or 180 degrees: plane undefined, skip
  }
}
for (let step = Math.PI / 720; step > 1e-7; step /= 2) {
  for (const phi of [best.phi - step, best.phi + step]) {
    const dv = tli(phi, ZERO).dv;
    if (dv < best.dv) best = { phi, dv };
  }
}

// --- 3. Fly it and correct the aim --------------------------------------------------------
interface Encounter {
  t: number;
  r: Vec3;
  v: Vec3;
  distance: number;
  speed: number;
}
/** Propagate until the range to the Moon stops shrinking; return the closest approach. */
function closestApproach(r0: Vec3, v0: Vec3): Encounter {
  const rangeRate = (t: number, r: Vec3, v: Vec3): number => dot(sub(r, moonAt(t)), sub(v, moonVelAt(t)));
  let prev = { t: 0, r: r0, v: v0 };
  let hit: { t: number; r: Vec3; v: Vec3 } | null = null;
  propagate(r0, v0, 0, tof * 1.6, fm, {
    hMax: 300,
    onStep: (t, r, v) => {
      if (t > tof * 0.5 && rangeRate(t, r, v) > 0) {
        hit = { t, r, v };
        return true;
      }
      prev = { t, r, v };
    },
  });
  if (!hit) throw new Error('never approached the Moon');
  // Bisect in time for the instant the range rate crosses zero.
  let lo = prev;
  let hiT = (hit as { t: number }).t;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo.t + hiT);
    const s = propagate(lo.r, lo.v, lo.t, mid, fm);
    if (rangeRate(mid, s.r, s.v) > 0) hiT = mid;
    else lo = { t: mid, r: s.r, v: s.v };
  }
  return { ...lo, distance: norm(sub(lo.r, moonAt(lo.t))), speed: norm(sub(lo.v, moonVelAt(lo.t))) };
}

const first = tli(best.phi, ZERO);
const firstPass = closestApproach(first.r, first.v);

// Differential correction: move the aim point against the miss until perilune sits
// 100 km above the surface. The Moon's gravity focuses the path, so iterate.
const rTarget = R_MOON + 100e3;
let offset: Vec3 = ZERO;
let burn = first;
let arrival = firstPass;
let corrections = 0;
for (; corrections < 60; corrections++) {
  const miss = sub(arrival.r, moonAt(arrival.t));
  const err = norm(miss) - rTarget;
  if (Math.abs(err) < 50) break;
  // Keep the aim point in the transfer plane: a near-180 degree transfer to a point out
  // of plane would need a costly plane change (the classic Lambert singularity).
  const inPlane = sub(miss, scale(normal, dot(miss, normal)));
  offset = sub(offset, scale(unit(inPlane), err));
  burn = tli(best.phi, offset);
  arrival = closestApproach(burn.r, burn.v);
}

// --- 4. Lunar orbit insertion -------------------------------------------------------------
const vRel = sub(arrival.v, moonVelAt(arrival.t));
const vCircMoon = Math.sqrt(MU_MOON / arrival.distance);
const loi = arrival.speed - vCircMoon;
const vAfter = add(moonVelAt(arrival.t), scale(unit(vRel), vCircMoon));
let minAlt = Infinity;
let maxAlt = -Infinity;
propagate(arrival.r, vAfter, arrival.t, arrival.t + 86400, fm, {
  hMax: 30,
  onStep: (t, r) => {
    const alt = norm(sub(r, moonAt(t))) - R_MOON;
    minAlt = Math.min(minAlt, alt);
    maxAlt = Math.max(maxAlt, alt);
  },
});

// --- Report ---------------------------------------------------------------------------------
const km = (m: number): string => (m / 1000).toFixed(0);
const ref = hohmann(rPark, norm(rMoonArr));
console.log(`Epoch ${epoch.toISOString()}, planned flight time ${(tof / 86400).toFixed(2)} days`);
console.log(`Parking orbit: 200 km circular, ${vPark.toFixed(0)} m/s, in the Moon's orbital plane`);
console.log(`Moon at arrival: ${km(norm(rMoonArr))} km from Earth, moving at ${norm(moonVelAt(tof)).toFixed(0)} m/s`);
console.log('');
console.log(`TLI burn (Lambert):           ${burn.dv.toFixed(1)} m/s   (Hohmann estimate to that distance: ${ref.dv1.toFixed(1)} m/s)`);
console.log(`Speed after TLI:              ${norm(burn.v).toFixed(0)} m/s   (escape speed there: ${(Math.SQRT2 * vPark).toFixed(0)} m/s)`);
console.log('');
console.log(`First try, aimed at the Moon's centre: closest approach ${km(firstPass.distance)} km from it`);
console.log("  (Lambert's two-body answer ignores the Moon's pull, the Sun and the Earth's oblateness)");
console.log(`Corrected aim point:          ${km(norm(offset))} km from the Moon's centre, after ${corrections} corrections`);
console.log(`Arrival:                      T+${(arrival.t / 86400).toFixed(3)} days, perilune altitude ${((arrival.distance - R_MOON) / 1000).toFixed(1)} km`);
console.log(`Speed relative to the Moon:   ${arrival.speed.toFixed(0)} m/s   (lunar escape speed there: ${(Math.SQRT2 * vCircMoon).toFixed(0)} m/s)`);
console.log(`Lunar orbit insertion burn:   ${loi.toFixed(1)} m/s retrograde -> circular at ${vCircMoon.toFixed(0)} m/s`);
console.log(`One day later:                altitude stays between ${minAlt === Infinity ? '?' : (minAlt / 1000).toFixed(1)} and ${(maxAlt / 1000).toFixed(1)} km above the Moon: captured`);
console.log(`Total delta-v from LEO:       ${(burn.dv + loi).toFixed(0)} m/s`);
