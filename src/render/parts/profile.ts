// Axisymmetric outline maths shared by every part design.
// Profiles are [s, r] pairs: s metres aft of the part's fore end, r the outer radius there.

import type { NoseCone, NoseShape, Transition } from '../../types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Radius of a nose of base radius R and length L at distance s from the tip. */
export function noseRadius(shape: NoseShape, shapeParam: number, R: number, L: number, s: number): number {
  const u = clamp(s / L, 0, 1);
  switch (shape) {
    case 'conical':
      return R * u;
    case 'ogive': {
      // shapeParam 1 = tangent ogive, 0 = cone; in between is a secant ogive (OpenRocket).
      const p = clamp(Number.isFinite(shapeParam) ? shapeParam : 1, 0, 1);
      if (p < 1e-3) return R * u;
      // Same arc OpenRocket draws: a circle of radius rho centred L/p aft of the tip.
      const pr = p * R;
      const rho = Math.sqrt(((L * L + R * R) * (((2 - p) * L) ** 2 + pr * pr)) / (4 * pr * pr));
      const cx = L / p;
      const y0 = Math.sqrt(Math.max(0, rho * rho - cx * cx));
      const sAbs = clamp(s, 0, L);
      return Math.max(0, Math.sqrt(Math.max(0, rho * rho - (cx - sAbs) * (cx - sAbs))) - y0);
    }
    case 'ellipsoid': {
      const q = 1 - u;
      return R * Math.sqrt(Math.max(0, 1 - q * q));
    }
    case 'power': {
      const p = shapeParam > 0 ? shapeParam : 0.5;
      return R * Math.pow(u, p);
    }
    case 'parabolic': {
      const K = clamp(Number.isFinite(shapeParam) ? shapeParam : 1, 0, 1);
      return (R * (2 * u - K * u * u)) / (2 - K);
    }
    case 'haack': {
      const C = Number.isFinite(shapeParam) ? shapeParam : 0;
      const th = Math.acos(clamp(1 - 2 * u, -1, 1));
      const val = (th - Math.sin(2 * th) / 2 + C * Math.pow(Math.sin(th), 3)) / Math.PI;
      return R * Math.sqrt(Math.max(0, val));
    }
    default:
      return R * u;
  }
}

/** Nose profile as [s, r] pairs, s from the tip (0) to the base (L), n points. */
export function noseProfile(
  shape: NoseShape,
  shapeParam: number,
  R: number,
  L: number,
  n: number,
): [number, number][] {
  const count = Math.max(2, Math.floor(n));
  if (!(L > 0) || !(R > 0)) return [[0, 0], [Math.max(L, 0) || 0, Math.max(R, 0) || 0]];
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const s = (L * i) / (count - 1);
    out.push([s, noseRadius(shape, shapeParam, R, L, s)]);
  }
  // The base always lands exactly on R so it meets the next part.
  out[count - 1] = [L, R];
  return out;
}

/**
 * Outline of a nose cone component, fore end first. A flipped nose (a tail cone) has
 * its wide end forward and its tip aft.
 */
export function noseConeProfile(c: NoseCone, n: number): [number, number][] {
  const prof = noseProfile(c.shape, c.shapeParam, c.baseRadius, c.length, n);
  if (!c.flipped) return prof;
  return prof.map(([s, r]) => [c.length - s, r] as [number, number]).reverse();
}

/**
 * Outline of a transition, fore end first. Conical unless the component carries a
 * shape. Follows OpenRocket: an unclipped shape adds a scaled nose curve to the small
 * radius; a clipped one cuts the front off a longer nose so the small end has a
 * visible corner.
 */
export function transitionProfile(c: Transition, n: number): [number, number][] {
  const count = Math.max(2, Math.floor(n));
  const L = c.length;
  const r1 = Math.max(0, c.foreRadius) || 0;
  const r2 = Math.max(0, c.aftRadius) || 0;
  const shape = c.shape ?? 'conical';
  if (!(L > 0)) return [[0, r1], [0, r2]];
  if (shape === 'conical' || Math.abs(r1 - r2) < 1e-9) {
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      out.push([L * u, r1 + (r2 - r1) * u]);
    }
    return out;
  }
  const small = Math.min(r1, r2);
  const big = Math.max(r1, r2);
  const param = c.shapeParam ?? 1;

  // Radius measured from the SMALL end, t metres along the axis.
  let fromSmall: (t: number) => number;
  if (c.clipped && small > 0) {
    // Find the extra length so a nose of base `big` has radius `small` at the cut.
    let lo = 0;
    let hi = L;
    for (let k = 0; k < 60 && noseRadius(shape, param, big, hi + L, hi) < small; k++) hi *= 2;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (noseRadius(shape, param, big, mid + L, mid) < small) lo = mid;
      else hi = mid;
    }
    const clip = (lo + hi) / 2;
    fromSmall = (t) => noseRadius(shape, param, big, clip + L, clip + t);
  } else {
    fromSmall = (t) => small + noseRadius(shape, param, big - small, L, t);
  }

  const out: [number, number][] = [];
  const smallFirst = r1 <= r2;
  for (let i = 0; i < count; i++) {
    const s = (L * i) / (count - 1);
    out.push([s, fromSmall(smallFirst ? s : L - s)]);
  }
  out[0] = [0, r1];
  out[count - 1] = [L, r2];
  return out;
}
