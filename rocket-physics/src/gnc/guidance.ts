// Closed-loop ascent guidance: linear-tangent steering solved by prediction and correction.
//
// Above the atmosphere the fuel-optimal way to steer a rocket to orbit is very nearly the
// "linear tangent law": the tangent of the pitch angle falls linearly with time,
//
//     tan(pitch) = k1 + k2 t
//
// (pitch measured from the local horizontal, in the plane of the target orbit). Three
// numbers define the rest of the flight: k1, k2 and the time to go T. Three conditions
// must hold at cutoff: the right radius, the right radial speed and the right angular
// momentum. So each guidance cycle integrates the remaining powered flight for a trial
// (k1, k2, T), looks at the miss, and corrects with Newton's method.
//
// The prediction uses the true inverse-square gravity and the actual thrust schedule,
// including staging gaps and the stages still to come. That matters for upper stages
// that cannot hold their own weight: guidance lofts the first stage on purpose, because
// it can see that the second will sag.

export interface BurnSegment {
  /** Seconds from now until this burn starts. */
  start: number;
  duration: number;
  /** Exhaust velocity, m/s. */
  ve: number;
  /** Mass at segment start divided by mass flow, s. Thrust acceleration is ve / (tau - s). */
  tau: number;
}

/** In-plane state: radius, radial speed, angular momentum about the target orbit normal. */
export interface PlanarState {
  r: number;
  rdot: number;
  h: number;
}

export interface SteeringLaw {
  k1: number;
  k2: number;
  /** Time to go until cutoff, s. */
  T: number;
}

export interface GuidanceSolution {
  law: SteeringLaw;
  converged: boolean;
  /** False when the stages on hand cannot reach the target: the law then burns to depletion. */
  feasible: boolean;
  iterations: number;
}

/** Delta-v the segments deliver in the first T seconds. */
export function deltaVUntil(segs: BurnSegment[], T: number): number {
  let dv = 0;
  for (const s of segs) {
    const d = Math.min(s.duration, T - s.start);
    if (d > 0) dv += -s.ve * Math.log(1 - d / s.tau);
  }
  return dv;
}

/** Time at which the cumulative delta-v reaches dv (end of the last burn if it never does). */
export function timeForDeltaV(segs: BurnSegment[], dv: number): number {
  let left = dv;
  for (const s of segs) {
    const total = -s.ve * Math.log(1 - s.duration / s.tau);
    if (left <= total) return s.start + s.tau * (1 - Math.exp(-left / s.ve));
    left -= total;
  }
  const last = segs[segs.length - 1];
  return last.start + last.duration;
}

/** Thrust acceleration at time t from now (0 during coast gaps). */
export function thrustAccelAt(segs: BurnSegment[], t: number): number {
  for (const s of segs) {
    const u = t - s.start;
    if (u >= -1e-9 && u <= s.duration + 1e-9) return s.ve / Math.max(s.tau - Math.min(Math.max(u, 0), s.duration), 1e-3);
  }
  return 0;
}

/** Move a time that falls in a coast gap to a burning instant. */
function snapToBurn(segs: BurnSegment[], T: number, forward: boolean): number {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (T < s.start) {
      if (forward || i === 0) return s.start + 0.05;
      const p = segs[i - 1];
      return p.start + p.duration;
    }
    if (T <= s.start + s.duration) return T;
  }
  const last = segs[segs.length - 1];
  return last.start + last.duration;
}

type Y = [number, number, number];

function rate(y: Y, a: number, k: number, mu: number): Y {
  const c = 1 / Math.sqrt(1 + k * k);
  const r = y[0];
  return [y[1], a * k * c - mu / (r * r) + (y[2] * y[2]) / (r * r * r), a * r * c];
}

/** Fly the steering law forward and return the state at cutoff. */
export function predictCutoff(state: PlanarState, law: SteeringLaw, mu: number, segs: BurnSegment[]): PlanarState {
  let y: Y = [state.r, state.rdot, state.h];
  let t = 0;
  const advance = (t1: number, accel: (t: number) => number): void => {
    const n = Math.max(1, Math.ceil((t1 - t) / 4));
    const h = (t1 - t) / n;
    for (let i = 0; i < n; i++) {
      const f = (tt: number, yy: Y): Y => rate(yy, accel(tt), law.k1 + law.k2 * tt, mu);
      const a1 = f(t, y);
      const a2 = f(t + h / 2, [y[0] + (h / 2) * a1[0], y[1] + (h / 2) * a1[1], y[2] + (h / 2) * a1[2]]);
      const a3 = f(t + h / 2, [y[0] + (h / 2) * a2[0], y[1] + (h / 2) * a2[1], y[2] + (h / 2) * a2[2]]);
      const a4 = f(t + h, [y[0] + h * a3[0], y[1] + h * a3[1], y[2] + h * a3[2]]);
      y = [
        y[0] + (h / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]),
        y[1] + (h / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]),
        y[2] + (h / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]),
      ];
      t += h;
    }
  };
  for (const s of segs) {
    if (law.T <= s.start) break;
    if (s.start > t) advance(s.start, () => 0);
    const end = Math.min(s.start + s.duration, law.T);
    if (end > t) advance(end, (tt) => s.ve / Math.max(s.tau - (tt - s.start), 1e-3));
  }
  // Cutoff time falls in a coast (before the next burn or after the last): fall freely to it.
  if (law.T > t) advance(law.T, () => 0);
  return { r: y[0], rdot: y[1], h: y[2] };
}

function solve3(m: number[][], b: number[]): number[] | null {
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!isFinite(det) || Math.abs(det) < 1e-300) return null;
  const col = (k: number): number => {
    const a = m.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
    return (
      (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
        a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
        a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])) /
      det
    );
  };
  return [col(0), col(1), col(2)];
}

/**
 * Find the steering law that reaches `target` from `state`.
 *
 * @param guess     previous solution (already advanced to the present), if any
 * @param pitchNow  current pitch above the horizon, rad; seeds the first solution
 */
export function solveSteering(
  state: PlanarState,
  target: PlanarState,
  mu: number,
  segs: BurnSegment[],
  guess?: SteeringLaw,
  pitchNow = 0.3,
): GuidanceSolution {
  const last = segs[segs.length - 1];
  const Tmax = last.start + last.duration;
  const Tmin = segs[0].start + 0.05;
  let k1: number, k2: number, T: number;
  if (guess) {
    ({ k1, k2, T } = guess);
  } else {
    T = timeForDeltaV(segs, Math.abs(target.h / target.r - state.h / state.r) * 1.1 + 100);
    k1 = Math.tan(Math.min(Math.max(pitchNow, 0.05), 1.2));
    k2 = -k1 / T;
  }
  T = snapToBurn(segs, Math.min(Math.max(T, Tmin), Tmax), true);
  let pinned = T >= Tmax - 1e-6; // out of propellant: T is no longer free
  const SCALE_R = 50; // seconds: turns a radius miss into a speed-like number
  const resid = (p: PlanarState): number[] => [(p.r - target.r) / SCALE_R, p.rdot - target.rdot, (p.h - target.h) / target.r];

  let converged = false;
  let iterations = 0;
  for (; iterations < 30; iterations++) {
    const base = predictCutoff(state, { k1, k2, T }, mu, segs);
    const F = resid(base);
    const miss = Math.max(Math.abs(F[0]), Math.abs(F[1]), pinned ? 0 : Math.abs(F[2]));
    if (miss < 0.05) {
      converged = true;
      break;
    }
    if (pinned && F[2] > 0) pinned = false; // more than enough after all
    const d1 = 1e-4;
    const d2 = 1e-4 / Math.max(T, 1);
    const F1 = resid(predictCutoff(state, { k1: k1 + d1, k2, T }, mu, segs));
    const F2 = resid(predictCutoff(state, { k1, k2: k2 + d2, T }, mu, segs));
    // Sensitivity to T is just the state rate at cutoff.
    const aT = thrustAccelAt(segs, T);
    const yd = rate([base.r, base.rdot, base.h], aT, k1 + k2 * T, mu);
    const JT = [yd[0] / SCALE_R, yd[1], yd[2] / target.r];
    let dx: number[] | null;
    if (pinned) {
      const a = (F1[0] - F[0]) / d1, b = (F2[0] - F[0]) / d2;
      const c = (F1[1] - F[1]) / d1, d = (F2[1] - F[1]) / d2;
      const det = a * d - b * c;
      dx = Math.abs(det) > 1e-300 ? [(-F[0] * d + b * F[1]) / det, (-a * F[1] + c * F[0]) / det, 0] : null;
    } else {
      const J = [0, 1, 2].map((i) => [(F1[i] - F[i]) / d1, (F2[i] - F[i]) / d2, JT[i]]);
      dx = solve3(J, [-F[0], -F[1], -F[2]]);
    }
    if (!dx || dx.some((v) => !isFinite(v))) break;
    // Damp large Newton steps: the problem is smooth but not linear.
    const lim = Math.max(Math.abs(dx[0]) / 0.4, (Math.abs(dx[1]) * Math.max(T, 1)) / 0.4, Math.abs(dx[2]) / (0.2 * T + 5), 1);
    k1 += dx[0] / lim;
    k2 += dx[1] / lim;
    const Tn = T + dx[2] / lim;
    if (Tn >= Tmax) {
      T = Tmax;
      pinned = true;
    } else {
      T = snapToBurn(segs, Math.max(Tn, Tmin), dx[2] > 0);
    }
  }
  return { law: { k1, k2, T }, converged, feasible: !pinned, iterations };
}
