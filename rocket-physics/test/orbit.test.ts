// Tests for the two-body orbit module: kepler.ts, lambert.ts, maneuvers.ts.
// Run with: node --test test/orbit.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MU_EARTH, RE } from '../src/constants.ts';
import { norm, sub, type Vec3 } from '../src/math/vec.ts';
import {
  elementsFromState,
  stateFromElements,
  solveKepler,
  solveKeplerHyperbolic,
  trueToEccentric,
  eccentricToTrue,
  trueToMean,
  meanToTrue,
  propagateKepler,
  timeToTrueAnomaly,
  timeToApoapsis,
  timeToPeriapsis,
} from '../src/orbit/kepler.ts';
import { lambert } from '../src/orbit/lambert.ts';
import {
  circularVelocity,
  escapeVelocity,
  visViva,
  orbitalPeriod,
  hohmann,
  biElliptic,
  planeChange,
  combinedPlaneChange,
  tsiolkovsky,
  burnTime,
  sphereOfInfluence,
  nodalPrecessionRate,
  apsidalPrecessionRate,
  sunSynchronousInclination,
  launchAzimuth,
  hyperbolicExcess,
  c3,
} from '../src/orbit/maneuvers.ts';

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const KM = 1e3;

/** Deterministic PRNG (mulberry32) so random cases are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signed angle difference wrapped to (-pi, pi]. */
function angDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Relative distance between two vectors. */
function relVec(a: Vec3, b: Vec3): number {
  return norm(sub(a, b)) / Math.max(norm(b), 1e-300);
}

test('Curtis example 4.3: state to elements', () => {
  const r: Vec3 = [-6045 * KM, -3490 * KM, 2500 * KM];
  const v: Vec3 = [-3.457 * KM, 6.618 * KM, 2.533 * KM];
  const el = elementsFromState(r, v, 3.986e14);
  assert.ok(Math.abs(el.h - 58310e6) / 58310e6 < 1e-3, `h = ${el.h}`);
  assert.ok(Math.abs(el.i / DEG - 153.2) < 0.1, `i = ${el.i / DEG}`);
  assert.ok(Math.abs(el.raan / DEG - 255.3) < 0.1, `raan = ${el.raan / DEG}`);
  assert.ok(Math.abs(el.e - 0.1712) < 1e-3 * 0.1712 + 1e-4, `e = ${el.e}`);
  assert.ok(Math.abs(el.argp / DEG - 20.07) < 0.1, `argp = ${el.argp / DEG}`);
  assert.ok(Math.abs(el.nu / DEG - 28.45) < 0.1, `nu = ${el.nu / DEG}`);
  assert.ok(el.ra > el.rp);
  assert.ok(Math.abs(el.rp - el.p / (1 + el.e)) < 1e-6);
});

test('elements round trip for random elliptic orbits', () => {
  const rand = rng(42);
  for (let k = 0; k < 300; k++) {
    const a = 6.6e6 + 4e7 * rand();
    const e = 0.02 + 0.9 * rand();
    const i = 0.05 + 3.0 * rand();
    const raan = TAU * rand();
    const argp = TAU * rand();
    const nu = TAU * rand();
    const s = stateFromElements({ a, e, i, raan, argp, nu });
    const el = elementsFromState(s.r, s.v);
    assert.ok(Math.abs(el.a - a) / a < 1e-9, 'a');
    assert.ok(Math.abs(el.e - e) < 1e-9, 'e');
    assert.ok(Math.abs(el.i - i) < 1e-9, 'i');
    assert.ok(Math.abs(angDiff(el.raan, raan)) < 1e-9, 'raan');
    assert.ok(Math.abs(angDiff(el.argp, argp)) < 1e-9, 'argp');
    assert.ok(Math.abs(angDiff(el.nu, nu)) < 1e-9, 'nu');
    const s2 = stateFromElements(el);
    assert.ok(relVec(s2.r, s.r) < 1e-9, 'r round trip');
    assert.ok(relVec(s2.v, s.v) < 1e-9, 'v round trip');
  }
});

test('elements round trip for a hyperbolic orbit', () => {
  const el0 = { a: -3e7, e: 1.6, i: 0.4, raan: 1.0, argp: 2.0, nu: 0.7 };
  const s = stateFromElements(el0);
  const el = elementsFromState(s.r, s.v);
  assert.ok(Math.abs(el.a - el0.a) / Math.abs(el0.a) < 1e-9);
  assert.ok(Math.abs(el.e - el0.e) < 1e-9);
  assert.ok(Math.abs(angDiff(el.nu, el0.nu)) < 1e-9);
  assert.ok(Math.abs(angDiff(el.argp, el0.argp)) < 1e-9);
  assert.ok(el.energy > 0);
  assert.equal(el.period, Infinity);
  assert.equal(el.ra, Infinity);
  const s2 = stateFromElements(el);
  assert.ok(relVec(s2.r, s.r) < 1e-9);
  assert.ok(relVec(s2.v, s.v) < 1e-9);
});

test('equatorial prograde and retrograde orbits round trip', () => {
  for (const i of [0, Math.PI]) {
    const el0 = { a: 9e6, e: 0.2, i, raan: 0, argp: 0.9, nu: 2.1 };
    const s = stateFromElements(el0);
    const el = elementsFromState(s.r, s.v);
    assert.ok(Math.abs(el.i - i) < 1e-9, `i=${i}`);
    assert.ok(Math.abs(angDiff(el.argp, el0.argp)) < 1e-9, `argp i=${i}`);
    assert.ok(Math.abs(angDiff(el.nu, el0.nu)) < 1e-9, `nu i=${i}`);
    const s2 = stateFromElements(el);
    assert.ok(relVec(s2.r, s.r) < 1e-9);
  }
  // Circular equatorial: nu is the true longitude.
  const c = stateFromElements({ a: 7e6, e: 0, i: 0, raan: 0, argp: 0, nu: 1.2 });
  const cel = elementsFromState(c.r, c.v);
  assert.ok(Math.abs(angDiff(cel.nu, 1.2)) < 1e-9);
  assert.ok(Math.abs(cel.h - Math.sqrt(MU_EARTH * 7e6)) / cel.h < 1e-12);
});

test('solveKepler residual over many M and e', () => {
  for (const e of [0, 0.1, 0.7, 0.99]) {
    for (let k = 0; k <= 400; k++) {
      const M = -20 + (40 * k) / 400;
      const E = solveKepler(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-12, `e=${e} M=${M}`);
    }
  }
});

test('solveKeplerHyperbolic residual', () => {
  for (const e of [1.01, 1.5, 3]) {
    for (let k = -50; k <= 50; k++) {
      const M = k * 0.7;
      const F = solveKeplerHyperbolic(M, e);
      assert.ok(Math.abs(e * Math.sinh(F) - F - M) < 1e-11 * Math.max(1, Math.abs(M)), `e=${e} M=${M}`);
    }
  }
});

test('anomaly conversions are mutually inverse', () => {
  for (const e of [0, 0.3, 0.8]) {
    for (let k = 0; k < 50; k++) {
      const nu = (TAU * k) / 50 + 0.01;
      const E = trueToEccentric(nu, e);
      assert.ok(Math.abs(angDiff(eccentricToTrue(E, e), nu)) < 1e-12, `E e=${e} nu=${nu}`);
      const M = trueToMean(nu, e);
      assert.ok(Math.abs(angDiff(meanToTrue(M, e), nu)) < 1e-10, `M e=${e} nu=${nu}`);
    }
  }
  for (const e of [1.2, 2.5]) {
    for (const nu of [-1.0, -0.3, 0, 0.4, 1.0]) {
      const F = trueToEccentric(nu, e);
      assert.ok(Math.abs(eccentricToTrue(F, e) - nu) < 1e-12, `hyperbolic e=${e} nu=${nu}`);
    }
  }
});

test('propagateKepler: full period returns to the start', () => {
  const s = stateFromElements({ a: 1.2e7, e: 0.4, i: 0.7, raan: 0.3, argp: 1.0, nu: 0.5 });
  const el = elementsFromState(s.r, s.v);
  const out = propagateKepler(s.r, s.v, el.period);
  assert.ok(norm(sub(out.r, s.r)) < 1e-3, `position error ${norm(sub(out.r, s.r))} m`);
  assert.ok(norm(sub(out.v, s.v)) < 1e-6, 'velocity');
  // Several periods, and a fractional period, agree with the reduced time.
  const out2 = propagateKepler(s.r, s.v, 3.37 * el.period);
  const ref = propagateKepler(s.r, s.v, 0.37 * el.period);
  assert.ok(relVec(out2.r, ref.r) < 1e-8);
});

test('propagateKepler conserves energy and angular momentum', () => {
  const s = stateFromElements({ a: 9e6, e: 0.55, i: 1.1, raan: 2.0, argp: 0.4, nu: 3.0 });
  const e0 = elementsFromState(s.r, s.v);
  for (const dt of [100, 2500, 9000]) {
    const out = propagateKepler(s.r, s.v, dt);
    const e1 = elementsFromState(out.r, out.v);
    assert.ok(Math.abs(e1.energy - e0.energy) / Math.abs(e0.energy) < 1e-10, `energy dt=${dt}`);
    assert.ok(Math.abs(e1.h - e0.h) / e0.h < 1e-10, `h dt=${dt}`);
  }
  // Hyperbolic too.
  const hs = stateFromElements({ a: -2e7, e: 1.4, i: 0.5, raan: 0.2, argp: 1.0, nu: 0.3 });
  const h0 = elementsFromState(hs.r, hs.v);
  const hout = propagateKepler(hs.r, hs.v, 3000);
  const h1 = elementsFromState(hout.r, hout.v);
  assert.ok(Math.abs(h1.energy - h0.energy) / Math.abs(h0.energy) < 1e-10);
  assert.ok(Math.abs(h1.h - h0.h) / h0.h < 1e-10);
});

test('propagateKepler: forward then backward returns to the start', () => {
  const ell = stateFromElements({ a: 1.0e7, e: 0.3, i: 0.9, raan: 0.6, argp: 2.2, nu: 1.7 });
  const hyp = stateFromElements({ a: -1.5e7, e: 1.3, i: 0.2, raan: 1.1, argp: 0.5, nu: -0.4 });
  const par = { r: [7e6, 0, 0] as Vec3, v: [0, Math.sqrt((2 * MU_EARTH) / 7e6), 0] as Vec3 };
  for (const s of [ell, hyp, par]) {
    for (const dt of [1234, 5000]) {
      const f = propagateKepler(s.r, s.v, dt);
      const b = propagateKepler(f.r, f.v, -dt);
      assert.ok(relVec(b.r, s.r) < 1e-9, `r dt=${dt}`);
      assert.ok(relVec(b.v, s.v) < 1e-9, `v dt=${dt}`);
    }
  }
});

test('propagateKepler agrees with mean-anomaly propagation (e = 0.6)', () => {
  const a = 1.2e7;
  const e = 0.6;
  const el0 = { a, e, i: 0.9, raan: 0.4, argp: 1.1, nu: 0.8 };
  const s = stateFromElements(el0);
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  for (const dt of [600, 3000, 11000]) {
    const M = trueToMean(el0.nu, e) + n * dt;
    const exp = stateFromElements({ ...el0, nu: meanToTrue(M, e) });
    const out = propagateKepler(s.r, s.v, dt);
    assert.ok(relVec(out.r, exp.r) < 1e-9, `r dt=${dt}`);
    assert.ok(relVec(out.v, exp.v) < 1e-9, `v dt=${dt}`);
  }
});

test('propagateKepler agrees with hyperbolic Kepler equation', () => {
  const a = -2.5e7;
  const e = 1.8;
  const el0 = { a, e, i: 0.6, raan: 0.9, argp: 0.3, nu: 0.5 };
  const s = stateFromElements(el0);
  const n = Math.sqrt(MU_EARTH / (-a * -a * -a));
  const M0 = trueToMean(el0.nu, e);
  for (const dt of [-4000, 800, 6000]) {
    const M = M0 + n * dt;
    const F = solveKeplerHyperbolic(M, e);
    const exp = stateFromElements({ ...el0, nu: eccentricToTrue(F, e) });
    const out = propagateKepler(s.r, s.v, dt);
    assert.ok(relVec(out.r, exp.r) < 1e-9, `r dt=${dt}`);
    assert.ok(relVec(out.v, exp.v) < 1e-9, `v dt=${dt}`);
  }
});

test('time to true anomaly: propagation lands on the target anomaly', () => {
  const s = stateFromElements({ a: 1.1e7, e: 0.45, i: 0.5, raan: 0.1, argp: 0.8, nu: 2.5 });
  const el = elementsFromState(s.r, s.v);
  const dt = timeToTrueAnomaly(el, 4.0);
  assert.ok(dt >= 0 && dt < el.period);
  const out = propagateKepler(s.r, s.v, dt);
  const after = elementsFromState(out.r, out.v);
  assert.ok(Math.abs(angDiff(after.nu, 4.0)) < 1e-9);
});

test('timeToApoapsis and timeToPeriapsis are consistent with the period', () => {
  const s = stateFromElements({ a: 8e6, e: 0.25, i: 0.3, raan: 0.2, argp: 0.7, nu: 4.4 });
  const el = elementsFromState(s.r, s.v);
  const tA = timeToApoapsis(el);
  const tP = timeToPeriapsis(el);
  assert.ok(tA >= 0 && tA < el.period);
  assert.ok(tP >= 0 && tP < el.period);
  // Periapsis follows apoapsis by half a period.
  const gap = ((tP - tA) % el.period + el.period) % el.period;
  assert.ok(Math.abs(gap - el.period / 2) < 1e-6 * el.period);
  // Propagating to apoapsis gives nu = pi.
  const out = propagateKepler(s.r, s.v, tA);
  assert.ok(Math.abs(angDiff(elementsFromState(out.r, out.v).nu, Math.PI)) < 1e-9);
  // Period from elements matches the closed form.
  assert.ok(Math.abs(el.period - orbitalPeriod(el.a)) / el.period < 1e-12);
});

test('lambert: Curtis example 5.2', () => {
  const mu = 398600 * 1e9; // km^3/s^2 -> m^3/s^2
  const r1: Vec3 = [5000 * KM, 10000 * KM, 2100 * KM];
  const r2: Vec3 = [-14600 * KM, 2500 * KM, 7000 * KM];
  const { v1, v2 } = lambert(r1, r2, 3600, mu, { prograde: true });
  const e1: Vec3 = [-5.9925 * KM, 1.9254 * KM, 3.2456 * KM];
  const e2: Vec3 = [-3.3125 * KM, -4.1966 * KM, -0.38529 * KM];
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(v1[k] - e1[k]) < 1, `v1[${k}] = ${v1[k]}`);
    assert.ok(Math.abs(v2[k] - e2[k]) < 1, `v2[${k}] = ${v2[k]}`);
  }
});

test('lambert: recovers the velocity of a propagated orbit (short and long way)', () => {
  const s = stateFromElements({ a: 9e6, e: 0.3, i: 0.7, raan: 0.9, argp: 0.5, nu: 0.3 });
  const el = elementsFromState(s.r, s.v);
  const normal = cross3(s.r, s.v);
  // Short way: about 0.2 of a period.
  const tofShort = 0.2 * el.period;
  const out1 = propagateKepler(s.r, s.v, tofShort);
  const sh = lambert(s.r, out1.r, tofShort, MU_EARTH, { normal });
  assert.ok(relVec(sh.v1, s.v) < 1e-6, `short v1 ${relVec(sh.v1, s.v)}`);
  assert.ok(relVec(sh.v2, out1.v) < 1e-6, `short v2 ${relVec(sh.v2, out1.v)}`);

  // Long way: about 0.6 of a period, so the true anomaly sweep exceeds 180 degrees.
  const tofLong = 0.6 * el.period;
  const out2 = propagateKepler(s.r, s.v, tofLong);
  const swept = (elementsFromState(out2.r, out2.v).nu - el.nu + TAU) % TAU;
  assert.ok(swept > Math.PI, `swept ${swept}`);
  const lg = lambert(s.r, out2.r, tofLong, MU_EARTH, { normal });
  assert.ok(relVec(lg.v1, s.v) < 1e-6, `long v1 ${relVec(lg.v1, s.v)}`);
  assert.ok(relVec(lg.v2, out2.v) < 1e-6, `long v2 ${relVec(lg.v2, out2.v)}`);
});

test('lambert: prograde and retrograde choices pick different transfers', () => {
  const r1: Vec3 = [7e6, 0, 0];
  const r2: Vec3 = [0, 7e6, 1e6];
  const pro = lambert(r1, r2, 2000, MU_EARTH, { prograde: true });
  const retro = lambert(r1, r2, 2000, MU_EARTH, { prograde: false });
  // Prograde angular momentum (r1 x v1) has positive z; retrograde has negative z.
  assert.ok(cross3(r1, pro.v1)[2] > 0);
  assert.ok(cross3(r1, retro.v1)[2] < 0);
  assert.ok(norm(sub(pro.v1, retro.v1)) > 1e3);
});

test('lambert: throws when the transfer angle is 180 degrees', () => {
  assert.throws(() => lambert([7e6, 0, 0], [-8e6, 0, 0], 1000), /transfer angle/);
});

test('hohmann LEO to GEO', () => {
  const r1 = RE + 300 * KM;
  const r2 = 42164 * KM;
  const h = hohmann(r1, r2);
  assert.ok(Math.abs(h.dv1 / 1000 - 2.43) / 2.43 < 0.01, `dv1 ${h.dv1}`);
  assert.ok(Math.abs(h.dv2 / 1000 - 1.47) / 1.47 < 0.01, `dv2 ${h.dv2}`);
  assert.ok(Math.abs(h.tof / 3600 - 5.26) / 5.26 < 0.01, `tof ${h.tof / 3600} h`);
  assert.ok(Math.abs(h.total - (h.dv1 + h.dv2)) < 1e-9);
});

test('bi-elliptic beats Hohmann for r2/r1 = 20 with a large apocentre', () => {
  const hoh = hohmann(1, 20);
  const bi = biElliptic(1, 20, 100);
  assert.ok(bi.total < hoh.total, `bi ${bi.total} vs hohmann ${hoh.total}`);
  // And does not beat it for a ratio well below the crossover.
  const hoh2 = hohmann(1, 5);
  const bi2 = biElliptic(1, 5, 100);
  assert.ok(bi2.total > hoh2.total);
});

test('escape velocity is sqrt(2) times circular velocity', () => {
  const r = RE + 400 * KM;
  assert.ok(Math.abs(escapeVelocity(r) / circularVelocity(r) - Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(visViva(r, r) - circularVelocity(r)) < 1e-9);
  assert.ok(Math.abs(hyperbolicExcess(escapeVelocity(r) * 1.2, r) - Math.sqrt(0.44) * escapeVelocity(r)) < 1e-6);
  assert.equal(hyperbolicExcess(1000, RE), 0);
  assert.ok(Math.abs(c3(2 * escapeVelocity(r), r) - 3 * escapeVelocity(r) ** 2) < 1e-6);
});

test('plane change formulas', () => {
  const v = 7500;
  const di = 28.5 * DEG;
  assert.ok(Math.abs(planeChange(v, di) - 2 * v * Math.sin(di / 2)) < 1e-9);
  assert.ok(Math.abs(combinedPlaneChange(v, v, di) - planeChange(v, di)) < 1e-6);
  assert.ok(Math.abs(combinedPlaneChange(v, 0, di) - v) < 1e-9);
});

test('rocket equation and burn time agree', () => {
  const isp = 300;
  assert.ok(Math.abs(tsiolkovsky(isp, 2, 1) - 9.80665 * isp * Math.LN2) < 1e-9);
  const m0 = 10000;
  const dv = 2000;
  const thrust = 50000;
  const t = burnTime(dv, m0, thrust, isp);
  const mdot = thrust / (9.80665 * isp);
  const m1 = m0 - mdot * t;
  assert.ok(Math.abs(m1 - m0 * Math.exp(-dv / (9.80665 * isp))) < 1e-6);
});

test('sphere of influence of Earth in the Sun field is about 0.92 million km', () => {
  const soi = sphereOfInfluence(1.495978707e11, 3.986004418e14, 1.32712440018e20);
  assert.ok(Math.abs(soi / 9.24e8 - 1) < 0.01, `soi ${soi}`);
});

test('ISS nodal precession is about -5.0 deg/day', () => {
  const a = RE + 420 * KM;
  const rate = nodalPrecessionRate(a, 0, 51.64 * DEG) * 86400 / DEG;
  assert.ok(Math.abs(rate / -5.0 - 1) < 0.02, `rate ${rate} deg/day`);
});

test('apsidal precession vanishes at the critical inclination 63.4 deg', () => {
  const ic = Math.acos(1 / Math.sqrt(5));
  assert.ok(Math.abs(apsidalPrecessionRate(RE + 800 * KM, 0.01, ic)) < 1e-15);
  assert.ok(apsidalPrecessionRate(RE + 800 * KM, 0.01, 0) > 0);
});

test('sun-synchronous inclination at 800 km is about 98.6 deg', () => {
  const i = sunSynchronousInclination(800 * KM) / DEG;
  assert.ok(Math.abs(i - 98.6) < 0.1, `i = ${i}`);
  // Nodal precession at that inclination is one revolution per year (eastward).
  const a = RE + 800 * KM;
  const rate = nodalPrecessionRate(a, 0, sunSynchronousInclination(800 * KM));
  assert.ok(Math.abs(rate - (2 * Math.PI) / (365.2422 * 86400)) < 1e-12);
});

test('launch azimuth from 28.5 deg latitude to 51.6 deg inclination', () => {
  const lat = 28.5 * DEG;
  const { inertial, rotating } = launchAzimuth(lat, 51.6 * DEG, 7670);
  assert.ok(Math.abs(inertial / DEG - 45.0) < 0.2, `inertial ${inertial / DEG}`);
  assert.ok(Math.abs(rotating / DEG - 42.8) < 0.5, `rotating ${rotating / DEG}`);
});

test('due-east launch (i = latitude) gives 90 degrees', () => {
  const lat = 28.5 * DEG;
  const { inertial } = launchAzimuth(lat, lat, 7670);
  assert.ok(Math.abs(inertial - Math.PI / 2) < 1e-9);
  assert.throws(() => launchAzimuth(lat, 10 * DEG, 7670), /latitude/);
});

test('small helper maneuvers', () => {
  const r = RE + 300 * KM;
  assert.ok(Math.abs(circularVelocity(r) - Math.sqrt(MU_EARTH / r)) < 1e-9);
  assert.ok(Math.abs(orbitalPeriod(r) - 2 * Math.PI * Math.sqrt(r ** 3 / MU_EARTH)) < 1e-6);
  // LEO period is about 90.5 minutes at 300 km.
  assert.ok(Math.abs(orbitalPeriod(r) / 60 - 90.5) < 0.5);
});

/** Cross product helper for building the orbit normal in tests. */
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
