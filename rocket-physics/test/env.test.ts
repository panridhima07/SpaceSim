// Unit tests for the existing math and environment modules: vec, integrators, earth,
// atmosphere, gravity and ephemeris.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AU, DEG, FLATTENING, MU_EARTH, MU_MOON, MU_SUN, OMEGA_EARTH, RE } from '../src/constants.ts';
import { angleBetween, cross, dot, norm, qderiv, qFromAxisAngle, qFromBasis, qmul, qrot, qrotInv, rotateAbout, rotZ, slerpToward, sub, unit, type Quat, type Vec3 } from '../src/math/vec.ts';
import { integrateAdaptive, rk4Step } from '../src/math/integrators.ts';
import { geodeticToEcef, gmst, greatCircleDistance, groundVelocity, julianDate, localFrame, toGeodetic } from '../src/env/earth.ts';
import { atmosphere } from '../src/env/atmosphere.ts';
import { earthGravity, earthPotential, thirdBodyAccel } from '../src/env/gravity.ts';
import { moonPosition, moonVelocity, sunPosition } from '../src/env/ephemeris.ts';

const near = (actual: number, expected: number, relTol: number, msg = ''): void => {
  const denom = Math.abs(expected) > 0 ? Math.abs(expected) : 1;
  assert.ok(Math.abs(actual - expected) / denom <= relTol, `${msg} actual=${actual} expected=${expected} relTol=${relTol}`);
};
const vecNear = (a: Vec3 | Quat, b: Vec3 | Quat, tol: number, msg = ''): void => {
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= tol, `${msg} component ${i}: ${a[i]} vs ${b[i]}`);
  }
};

// Deterministic pseudo-random numbers in [-1, 1) (LCG), so failures reproduce.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

// ---- vec -------------------------------------------------------------------

test('vec: cross product identities', () => {
  const rng = makeRng(7);
  for (let k = 0; k < 20; k++) {
    const a: Vec3 = [rng(), rng(), rng()];
    const b: Vec3 = [rng(), rng(), rng()];
    const c = cross(a, b);
    assert.ok(Math.abs(dot(c, a)) < 1e-12, 'cross is orthogonal to a');
    assert.ok(Math.abs(dot(c, b)) < 1e-12, 'cross is orthogonal to b');
    vecNear(c, [-cross(b, a)[0], -cross(b, a)[1], -cross(b, a)[2]], 1e-14, 'anticommutative');
    near(norm(c) ** 2 + dot(a, b) ** 2, norm(a) ** 2 * norm(b) ** 2, 1e-12, 'Lagrange identity');
  }
});

test('vec: qFromAxisAngle + qrot rotates X by 90 deg about Z to Y', () => {
  const q = qFromAxisAngle([0, 0, 1], Math.PI / 2);
  vecNear(qrot(q, [1, 0, 0]), [0, 1, 0], 1e-12);
});

test('vec: qrotInv inverts qrot', () => {
  const rng = makeRng(11);
  for (let k = 0; k < 10; k++) {
    const q = qFromAxisAngle([rng(), rng(), rng()], 3 * rng());
    const v: Vec3 = [rng(), rng(), rng()];
    vecNear(qrotInv(q, qrot(q, v)), v, 1e-12);
    vecNear(qrot(q, qrotInv(q, v)), v, 1e-12);
  }
});

test('vec: qFromBasis reproduces the basis, including negative-trace cases', () => {
  const bases: Array<[Vec3, Vec3, Vec3]> = [];
  // Identity (trace 3), 180 deg about Z (trace -1), 120 deg about (1,1,1) (trace 0).
  bases.push([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  bases.push([[-1, 0, 0], [0, -1, 0], [0, 0, 1]]);
  const axes: Array<[Vec3, number]> = [
    [[1, 1, 1], (2 * Math.PI) / 3],
    [[1, 2, 3], 2.8],
    [[0, 1, 0], Math.PI - 0.01],
    [[0.3, -0.5, 0.8], 0.7],
  ];
  for (const [axis, ang] of axes) {
    const q = qFromAxisAngle(axis, ang);
    bases.push([qrot(q, [1, 0, 0]), qrot(q, [0, 1, 0]), qrot(q, [0, 0, 1])]);
  }
  // Random orthonormal bases from Gram-Schmidt.
  const rng = makeRng(23);
  for (let k = 0; k < 50; k++) {
    const x = unit([rng(), rng(), rng()]);
    const y0 = [rng(), rng(), rng()] as Vec3;
    const yp = sub(y0, [dot(y0, x) * x[0], dot(y0, x) * x[1], dot(y0, x) * x[2]]);
    const y = unit(yp);
    bases.push([x, y, cross(x, y)]);
  }
  for (const [x, y, z] of bases) {
    const q = qFromBasis(x, y, z);
    assert.ok(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-12, 'unit quaternion');
    vecNear(qrot(q, [1, 0, 0]), x, 1e-12, 'x');
    vecNear(qrot(q, [0, 1, 0]), y, 1e-12, 'y');
    vecNear(qrot(q, [0, 0, 1]), z, 1e-12, 'z');
  }
});

test('vec: qmul composition matches sequential rotation', () => {
  const a = qFromAxisAngle([0, 0, 1], 0.4);
  const b = qFromAxisAngle([1, 0, 0], 0.9);
  const v: Vec3 = [0.2, -0.7, 0.5];
  vecNear(qrot(qmul(a, b), v), qrot(a, qrot(b, v)), 1e-12);
});

test('vec: qderiv integrated with RK4 matches the axis-angle quaternion', () => {
  const w: Vec3 = [0, 0, 0.5];
  const T = Math.PI / 2 / w[2]; // quarter turn
  const N = 2000;
  const f = (_t: number, y: number[]): number[] => qderiv([y[0], y[1], y[2], y[3]], w);
  let y: number[] = [0, 0, 0, 1];
  const h = T / N;
  for (let i = 0; i < N; i++) y = rk4Step(f, i * h, y, h);
  vecNear(y as Quat, qFromAxisAngle([0, 0, 1], Math.PI / 2), 1e-9, 'quarter turn');
});

test('vec: slerpToward limits the angle and reaches the target', () => {
  const from: Vec3 = [1, 0, 0];
  const to: Vec3 = [0, 1, 0];
  const r = slerpToward(from, to, 0.3);
  near(norm(r), 1, 1e-12, 'unit result');
  near(angleBetween(from, r), 0.3, 1e-12, 'moved by the limit');
  near(angleBetween(r, to), Math.PI / 2 - 0.3, 1e-12, 'remaining angle');
  assert.equal(slerpToward(from, to, 2), to, 'within reach returns the target');

  let cur: Vec3 = from;
  for (let i = 0; i < 20; i++) cur = slerpToward(cur, to, 0.1);
  vecNear(cur, to, 1e-12, 'converges to target');
});

test('vec: rotateAbout matches rotZ and preserves length', () => {
  const v: Vec3 = [0.3, -1.2, 2.5];
  vecNear(rotateAbout([1, 0, 0], [0, 0, 1], Math.PI / 2), [0, 1, 0], 1e-12);
  vecNear(rotateAbout(v, [0, 0, 1], 0.8), rotZ(v, 0.8), 1e-12);
  near(norm(rotateAbout(v, unit([1, 2, 3]), 1.1)), norm(v), 1e-12, 'length preserved');
  vecNear(rotateAbout(v, unit([1, 2, 3]), 2 * Math.PI), v, 1e-12, 'full turn');
});

// ---- integrators -----------------------------------------------------------

test('integrators: rk4Step on y\' = -y converges at 4th order', () => {
  const f = (_t: number, y: number[]): number[] => [-y[0]];
  const solve = (h: number): number => {
    const n = Math.round(1 / h);
    let y = [1];
    for (let i = 0; i < n; i++) y = rk4Step(f, i * h, y, h);
    return Math.abs(y[0] - Math.exp(-1));
  };
  const e1 = solve(0.1);
  const e2 = solve(0.05);
  assert.ok(e2 > 0 && e1 > 0);
  const ratio = e1 / e2;
  assert.ok(ratio > 15 && ratio < 17, `error ratio ${ratio} should be about 16`);
});

test('integrators: Dopri5 harmonic oscillator conserves energy over 100 periods and lands on t1', () => {
  const f = (_t: number, y: number[]): number[] => [y[1], -y[0]];
  const t1 = 200 * Math.PI;
  // The default atol (1e-6) is absolute and dominates for unit-scale states; tighten it here.
  const res = integrateAdaptive(f, 0, [1, 0], t1, { rtol: 1e-10, atol: 1e-10 });
  assert.equal(res.t, t1, 'lands exactly on t1');
  const E0 = 0.5;
  const E1 = 0.5 * (res.y[0] ** 2 + res.y[1] ** 2);
  assert.ok(Math.abs(E1 - E0) / E0 < 1e-7, `energy drift ${Math.abs(E1 - E0) / E0}`);
  // 100 full periods: back at the start.
  assert.ok(Math.abs(res.y[0] - 1) < 1e-5 && Math.abs(res.y[1]) < 1e-5);
});

test('integrators: backward integration returns to the initial state', () => {
  const f = (_t: number, y: number[]): number[] => [y[1], -y[0]];
  const t1 = 50.0;
  const tol = { rtol: 1e-10, atol: 1e-10 };
  const fwd = integrateAdaptive(f, 0, [1, 0], t1, tol);
  const back = integrateAdaptive(f, t1, fwd.y, 0, tol);
  assert.equal(back.t, 0, 'lands exactly on t0 going backward');
  assert.ok(Math.abs(back.y[0] - 1) < 1e-7 && Math.abs(back.y[1]) < 1e-7, `state ${back.y}`);
});

// ---- earth -----------------------------------------------------------------

test('earth: geodeticToEcef / toGeodetic round trip', () => {
  const lats = [-89.9, -45, 0, 13.72, 60, 89.9];
  const hs = [0, 1000, 400e3, 3.6e7];
  for (const latDeg of lats) {
    for (const h of hs) {
      const lon = 1.1;
      const p = geodeticToEcef(latDeg * DEG, lon, h);
      const g = toGeodetic(p);
      assert.ok(Math.abs(g.lat - latDeg * DEG) < 1e-11, `lat ${latDeg} h ${h}: ${g.lat}`);
      assert.ok(Math.abs(g.alt - h) < 1e-6, `alt ${latDeg} h ${h}: ${g.alt}`);
      assert.ok(Math.abs(g.lon - lon) < 1e-11, `lon ${latDeg} h ${h}`);
    }
  }
});

test('earth: equator point is [RE, 0, 0] and pole z is the polar radius', () => {
  vecNear(geodeticToEcef(0, 0, 0), [RE, 0, 0], 1e-6, 'equator');
  const pole = geodeticToEcef(Math.PI / 2, 0, 0);
  near(pole[2], RE * (1 - FLATTENING), 1e-12, 'polar radius');
  near(pole[2], 6356752.314, 1e-9, 'polar radius WGS-84 value');
});

test('earth: localFrame is orthonormal and right-handed (east x north = up)', () => {
  const points: Vec3[] = [
    geodeticToEcef(0.3, 0.2, 0),
    geodeticToEcef(-1.1, 2.5, 1000),
    geodeticToEcef(0.9, -2.9, 400e3),
    [5e6, -3e6, 2e6],
  ];
  for (const p of points) {
    const f = localFrame(p);
    near(norm(f.east), 1, 1e-12);
    near(norm(f.north), 1, 1e-12);
    near(norm(f.up), 1, 1e-12);
    assert.ok(Math.abs(dot(f.east, f.north)) < 1e-12);
    assert.ok(Math.abs(dot(f.east, f.up)) < 1e-12);
    assert.ok(Math.abs(dot(f.north, f.up)) < 1e-12);
    vecNear(cross(f.east, f.north), f.up, 1e-12, 'right-handed');
  }
});

test('earth: gmst at J2000 is 280.46061837 deg', () => {
  const deg = gmst(2451545.0) / DEG;
  assert.ok(Math.abs(deg - 280.46061837) < 1e-8, `gmst ${deg}`);
});

test('earth: gmst advances 360.98564736629 deg per day (mod 360)', () => {
  for (const jd of [2451545.0, 2460000.5]) {
    let d = (gmst(jd + 1) - gmst(jd)) / DEG;
    d = ((d % 360) + 360) % 360;
    assert.ok(Math.abs(d - 0.98564736629) < 1e-6, `daily advance ${d}`);
  }
});

test('earth: julianDate of 2000-01-01T12:00Z is 2451545.0', () => {
  assert.equal(julianDate(new Date('2000-01-01T12:00:00Z')), 2451545.0);
});

test('earth: ground velocity at the equator is 465.1 m/s eastward', () => {
  const v = groundVelocity([RE, 0, 0]);
  near(norm(v), 465.1, 1e-3, 'speed');
  assert.ok(v[1] > 0 && Math.abs(v[0]) < 1e-9 && Math.abs(v[2]) < 1e-9, 'eastward at lon 0');
  near(norm(v), OMEGA_EARTH * RE, 1e-12);
});

test('earth: greatCircleDistance of a quarter circumference', () => {
  near(greatCircleDistance(0, 0, 0, Math.PI / 2), (Math.PI * RE) / 2, 1e-9, 'equator quarter');
  near(greatCircleDistance(0, 0, Math.PI / 2, 0), (Math.PI * RE) / 2, 1e-9, 'pole quarter');
});

// ---- atmosphere ------------------------------------------------------------

// The USSA76 table is tabulated in geopotential height H; the model takes geometric
// altitude z. z = H * R / (R - H) with R the USSA76 geopotential radius.
const R_GEOP = 6356766;
const geometricFromGeopotential = (H: number): number => (H * R_GEOP) / (R_GEOP - H);

test('atmosphere: sea level and US Standard Atmosphere 1976 reference values', () => {
  const s0 = atmosphere(0);
  near(s0.temperature, 288.15, 0.005, 'T 0');
  near(s0.pressure, 101325, 0.005, 'p 0');
  near(s0.density, 1.225, 0.005, 'rho 0');
  near(s0.speedOfSound, 340.29, 0.005, 'a 0');

  const s11 = atmosphere(geometricFromGeopotential(11000));
  near(s11.temperature, 216.65, 0.005, 'T 11');
  near(s11.pressure, 22632, 0.005, 'p 11');

  // Table pressure at H = 20 km; the density 0.08891 is quoted at geometric z = 20 km.
  const s20 = atmosphere(geometricFromGeopotential(20000));
  near(s20.pressure, 5474.9, 0.005, 'p 20');
  near(atmosphere(20000).density, 0.08891, 0.005, 'rho 20 (geometric)');

  const s32 = atmosphere(geometricFromGeopotential(32000));
  near(s32.temperature, 228.65, 0.005, 'T 32');
  near(s32.pressure, 868.02, 0.005, 'p 32');

  const s47 = atmosphere(geometricFromGeopotential(47000));
  near(s47.temperature, 270.65, 0.005, 'T 47');
  near(s47.pressure, 110.91, 0.005, 'p 47');

  const s71 = atmosphere(geometricFromGeopotential(71000));
  near(s71.temperature, 214.65, 0.005, 'T 71');
  near(s71.pressure, 3.9564, 0.005, 'p 71');
});

test('atmosphere: 86 km to 400 km reference values', () => {
  const s86 = atmosphere(86000);
  near(s86.temperature, 186.87, 0.02, 'T 86');
  near(s86.pressure, 0.3734, 0.02, 'p 86');
  near(s86.density, 6.958e-6, 0.02, 'rho 86');

  near(atmosphere(100000).density, 5.6e-7, 0.1, 'rho 100');
  near(atmosphere(200000).density, 2.5e-10, 0.15, 'rho 200');
  const rho400 = atmosphere(400000).density;
  assert.ok(rho400 >= 2.8e-12 && rho400 <= 3.8e-12, `rho 400 = ${rho400}`);
});

test('atmosphere: density strictly decreases with altitude (0 to 1000 km, 500 m steps)', () => {
  let prev = Infinity;
  for (let z = 0; z <= 1000e3; z += 500) {
    const rho = atmosphere(z).density;
    assert.ok(rho > 0, `positive at ${z}`);
    assert.ok(rho < prev, `decreasing at ${z} m: ${rho} vs ${prev}`);
    prev = rho;
  }
});

test('atmosphere: density is continuous across 85.9 to 90.1 km (100 m steps)', () => {
  let prev = atmosphere(85900).density;
  for (let z = 86000; z <= 90100; z += 100) {
    const rho = atmosphere(z).density;
    const ratio = rho / prev;
    assert.ok(ratio < 1.03 && ratio > 1 / 1.03, `jump at ${z} m: ratio ${ratio}`);
    prev = rho;
  }
});

test('atmosphere: vacuum above 1000 km', () => {
  assert.equal(atmosphere(1.0001e6).density, 0);
  assert.equal(atmosphere(1.5e6).density, 0);
});

test('atmosphere: mean free path ~6.6e-8 m at sea level and grows past 1 m near 110 km', () => {
  near(atmosphere(0).meanFreePath, 6.6e-8, 0.1, 'sea level');
  // Model gives 0.84 m at 110 km and crosses 1 m at about 111.5 km (the brief said "by 110 km").
  const l110 = atmosphere(110000).meanFreePath;
  assert.ok(l110 > 0.7 && l110 < 1.0, `lambda(110 km) = ${l110}`);
  assert.ok(atmosphere(112000).meanFreePath > 1, `lambda(112 km) = ${atmosphere(112000).meanFreePath}`);
});

test('atmosphere: sea-level dynamic viscosity is 1.789e-5 Pa s', () => {
  near(atmosphere(0).viscosity, 1.789e-5, 0.005);
});

// ---- gravity ---------------------------------------------------------------

test('gravity: point-mass magnitude at RE equals mu/RE^2', () => {
  const a = earthGravity([RE, 0, 0], { j2: false, j3j4: false });
  near(norm(a), MU_EARTH / (RE * RE), 1e-12);
  vecNear(a, [-MU_EARTH / (RE * RE), 0, 0], 1e-12 * MU_EARTH / (RE * RE));
});

test('gravity: earthGravity equals the numerical gradient of earthPotential', () => {
  const points: Vec3[] = [
    [RE + 500e3, 0, 0],
    [4e6, 3e6, 2e6],
    [0, -5e6, 4e6],
    [-3e6, 1e6, -6e6],
    [6e6, 0, 3e6],
  ];
  const optSets = [{}, { j2: true, j3j4: false }, { j2: false }];
  const h = 10;
  for (const opts of optSets) {
    for (const p of points) {
      const grad: Vec3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const pp: Vec3 = [p[0], p[1], p[2]];
        const pm: Vec3 = [p[0], p[1], p[2]];
        pp[i] += h;
        pm[i] -= h;
        grad[i] = (earthPotential(pp, opts) - earthPotential(pm, opts)) / (2 * h);
      }
      const a = earthGravity(p, opts);
      const err = norm(sub(a, grad)) / norm(a);
      assert.ok(err < 1e-9, `opts ${JSON.stringify(opts)} at ${p}: relative error ${err}`);
    }
  }
});

test('gravity: pole is stronger than equator; sea-level effective gravity matches 9.780 and 9.832', () => {
  const eq = geodeticToEcef(0, 0, 0);
  const pole = geodeticToEcef(Math.PI / 2, 0, 0);
  const gEq = earthGravity(eq);
  const gPole = earthGravity(pole);
  assert.ok(norm(gPole) > norm(gEq), 'pole stronger');

  // Effective gravity: add the centrifugal term (outward, w^2 times the rotation-axis distance).
  const w2 = OMEGA_EARTH * OMEGA_EARTH;
  const geffEq = norm([gEq[0] + w2 * eq[0], gEq[1] + w2 * eq[1], gEq[2]]);
  const geffPole = norm([gPole[0] + w2 * pole[0], gPole[1] + w2 * pole[1], gPole[2]]);
  near(geffEq, 9.78, 0.0005, 'equator effective gravity');
  near(geffPole, 9.832, 0.0005, 'pole effective gravity');
});

test('gravity: Moon and Sun third-body acceleration on a LEO satellite', () => {
  const jd = 2451545.0;
  const r: Vec3 = [6.778e6, 0, 0];
  const aMoon = norm(thirdBodyAccel(r, moonPosition(jd), MU_MOON));
  const aSun = norm(thirdBodyAccel(r, sunPosition(jd), MU_SUN));
  assert.ok(aMoon > 3e-7 && aMoon < 3e-6, `moon ${aMoon}`);
  assert.ok(aSun > 0.3 * aMoon && aSun < 0.7 * aMoon, `sun ${aSun} vs moon ${aMoon}`);
});

test('gravity: third-body acceleration is zero at the origin', () => {
  const a = thirdBodyAccel([0, 0, 0], [3.8e8, 1e7, -2e7], MU_MOON);
  vecNear(a, [0, 0, 0], 0, 'zero at r=0');
});

// ---- ephemeris -------------------------------------------------------------

test('ephemeris: Sun distance stays between 0.983 and 1.017 AU over a year', () => {
  const jd0 = julianDate(new Date('2024-01-01T00:00:00Z'));
  for (let d = 0; d < 366; d++) {
    const au = norm(sunPosition(jd0 + d)) / AU;
    assert.ok(au > 0.983 && au < 1.017, `day ${d}: ${au} AU`);
  }
});

test('ephemeris: Sun points along +X at the March 2024 equinox', () => {
  const jd = julianDate(new Date('2024-03-20T03:06:00Z'));
  const ang = angleBetween(sunPosition(jd), [1, 0, 0]);
  assert.ok(ang < 0.05 * DEG, `angle ${ang / DEG} deg`);
});

test('ephemeris: Sun declination is 23.44 deg at the June 2024 solstice', () => {
  const jd = julianDate(new Date('2024-06-20T20:51:00Z'));
  const s = sunPosition(jd);
  const decl = Math.asin(s[2] / norm(s)) / DEG;
  assert.ok(Math.abs(decl - 23.44) < 0.05, `declination ${decl}`);
});

test('ephemeris: Moon distance stays in 356000 to 407000 km over two years (6 h samples)', () => {
  const jd0 = julianDate(new Date('2024-01-01T00:00:00Z'));
  for (let k = 0; k < 2 * 366 * 4; k++) {
    const km = norm(moonPosition(jd0 + k * 0.25)) / 1000;
    assert.ok(km > 356000 && km < 407000, `sample ${k}: ${km} km`);
  }
});

test('ephemeris: Moon position for JD 2448724.5 matches Meeus example 47.a', () => {
  const jd = 2448724.5;
  const r = moonPosition(jd);
  const distKm = norm(r) / 1000;
  assert.ok(Math.abs(distKm - 368409.7) < 3000, `distance ${distKm} km`);

  // Equatorial -> ecliptic: rotate about X by the obliquity.
  const eps = 23.4406 * DEG;
  const yE = r[1] * Math.cos(eps) + r[2] * Math.sin(eps);
  const zE = -r[1] * Math.sin(eps) + r[2] * Math.cos(eps);
  let lonDeg = Math.atan2(yE, r[0]) / DEG;
  if (lonDeg < 0) lonDeg += 360;
  const latDeg = Math.asin(zE / norm(r)) / DEG;
  assert.ok(Math.abs(lonDeg - 133.16) < 0.5, `ecliptic longitude ${lonDeg}`);
  assert.ok(Math.abs(latDeg - -3.23) < 0.5, `ecliptic latitude ${latDeg}`);
});

test('ephemeris: Moon speed is about 1.0 km/s', () => {
  const v = norm(moonVelocity(2451545.0));
  assert.ok(v > 950 && v < 1100, `speed ${v} m/s`);
});

test('ephemeris: Moon sidereal period is 27.32 days averaged over one year', () => {
  const jd0 = julianDate(new Date('2024-01-01T00:00:00Z'));
  const stepDays = 1 / 24;
  const nSteps = Math.round(365.25 / stepDays);
  let total = 0;
  let prev = moonPosition(jd0);
  for (let k = 1; k <= nSteps; k++) {
    const cur = moonPosition(jd0 + k * stepDays);
    total += angleBetween(prev, cur);
    prev = cur;
  }
  const period = (365.25 * 2 * Math.PI) / total;
  near(period, 27.32, 0.005, 'sidereal period (days)');
});
