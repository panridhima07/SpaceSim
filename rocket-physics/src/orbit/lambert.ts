// Lambert's problem: the two-body transfer orbit joining two position vectors in a given time.
// Single-revolution solver in universal variables (Vallado alg. 58 / Curtis alg. 5.2), with
// bisection on the universal variable psi. Pure function, SI units.

import { MU_EARTH } from '../constants.ts';
import { angleBetween, cross, dot, norm, type Vec3 } from '../math/vec.ts';

/** Stumpff C(z); same definition as in kepler.ts (kept private to keep that module's exports exact). */
function stumpffC(z: number): number {
  if (Math.abs(z) < 0.5) {
    let p = 1, tc = 0.5, c = 0;
    for (let n = 0; n < 30; n++) {
      c += p * tc;
      p *= -z;
      tc /= (2 * n + 3) * (2 * n + 4);
    }
    return c;
  }
  if (z > 0) return (1 - Math.cos(Math.sqrt(z))) / z;
  return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
}

/** Stumpff S(z); same definition as in kepler.ts. */
function stumpffS(z: number): number {
  if (Math.abs(z) < 0.5) {
    let p = 1, ts = 1 / 6, s = 0;
    for (let n = 0; n < 30; n++) {
      s += p * ts;
      p *= -z;
      ts /= (2 * n + 4) * (2 * n + 5);
    }
    return s;
  }
  if (z > 0) {
    const r = Math.sqrt(z);
    return (r - Math.sin(r)) / (r * r * r);
  }
  const r = Math.sqrt(-z);
  return (Math.sinh(r) - r) / (r * r * r);
}

/**
 * Velocities at r1 and r2 of the transfer orbit that reaches r2 from r1 in time tof.
 *
 * Direction: with opts.normal, the short or long way is chosen so the orbit angular momentum
 * points along normal. Otherwise opts.prograde (default true) selects the way whose angular
 * momentum has positive Z (prograde) or negative Z (retrograde).
 *
 * Throws if the transfer angle is 0 or 180 degrees (the transfer plane is undefined).
 */
export function lambert(
  r1: Vec3,
  r2: Vec3,
  tof: number,
  mu = MU_EARTH,
  opts: { prograde?: boolean; normal?: Vec3 } = {},
): { v1: Vec3; v2: Vec3 } {
  if (!(tof > 0)) throw new Error('lambert: time of flight must be positive');
  const r1n = norm(r1);
  const r2n = norm(r2);
  const c = cross(r1, r2);
  const short = angleBetween(r1, r2); // in [0, pi]
  let useShort: boolean;
  if (opts.normal) useShort = dot(c, opts.normal) >= 0;
  else useShort = (c[2] >= 0) === (opts.prograde ?? true);
  const dnu = useShort ? short : 2 * Math.PI - short;

  const sinD = Math.sin(dnu);
  const cosD = Math.cos(dnu);
  if (Math.abs(sinD) < 1e-10 || 1 - cosD === 0) {
    throw new Error('lambert: transfer angle is 0 or 180 degrees; the transfer plane is undefined');
  }
  const A = sinD * Math.sqrt((r1n * r2n) / (1 - cosD));
  const sqrtMu = Math.sqrt(mu);

  const y = (psi: number): number => {
    const C = stumpffC(psi);
    const S = stumpffS(psi);
    return r1n + r2n + (A * (psi * S - 1)) / Math.sqrt(C);
  };

  /** Time of flight for a given psi (Vallado eq. for dt(psi)); t increases with psi. */
  const tOf = (psi: number, yy: number): number => {
    const C = stumpffC(psi);
    const S = stumpffS(psi);
    const chi = Math.sqrt(yy / C);
    return (chi * chi * chi * S + A * Math.sqrt(yy)) / sqrtMu;
  };

  // Bracket psi. y(psi) increases with psi and must be >= 0; bisect for its zero crossing so the
  // lower bound has t(psiL) = 0 < tof. The upper bound starts at 4 pi^2 and doubles if needed.
  const twoPi2 = 4 * Math.PI * Math.PI;
  let psiL = -4 * twoPi2;
  let psiU = twoPi2;
  if (y(psiL) < 0) {
    let lo = psiL;
    let hi = psiU;
    for (let k = 0; k < 200; k++) {
      const mid = 0.5 * (lo + hi);
      if (y(mid) < 0) lo = mid;
      else hi = mid;
    }
    psiL = hi;
  }
  for (let k = 0; k < 100 && tOf(psiU, y(psiU)) < tof; k++) psiU *= 2;

  let yy = NaN;
  let converged = false;
  for (let it = 0; it < 1000; it++) {
    const psi = 0.5 * (psiL + psiU);
    yy = y(psi);
    const t = tOf(psi, yy);
    if (Math.abs(t - tof) <= 1e-8 * tof) {
      converged = true;
      break;
    }
    if (t <= tof) psiL = psi;
    else psiU = psi;
  }
  if (!converged) throw new Error('lambert: bisection on psi did not converge');

  const f = 1 - yy / r1n;
  const g = A * Math.sqrt(yy / mu);
  const gdot = 1 - yy / r2n;
  const v1: Vec3 = [(r2[0] - f * r1[0]) / g, (r2[1] - f * r1[1]) / g, (r2[2] - f * r1[2]) / g];
  const v2: Vec3 = [(gdot * r2[0] - r1[0]) / g, (gdot * r2[1] - r1[1]) / g, (gdot * r2[2] - r1[2]) / g];
  return { v1, v2 };
}
