// Ordinary differential equation steppers on plain number arrays.

export type Deriv = (t: number, y: number[]) => number[];

/** Classical fixed-step 4th order Runge-Kutta. */
export function rk4Step(f: Deriv, t: number, y: number[], h: number): number[] {
  const n = y.length;
  const k1 = f(t, y);
  const y2 = new Array<number>(n);
  for (let i = 0; i < n; i++) y2[i] = y[i] + 0.5 * h * k1[i];
  const k2 = f(t + 0.5 * h, y2);
  const y3 = new Array<number>(n);
  for (let i = 0; i < n; i++) y3[i] = y[i] + 0.5 * h * k2[i];
  const k3 = f(t + 0.5 * h, y3);
  const y4 = new Array<number>(n);
  for (let i = 0; i < n; i++) y4[i] = y[i] + h * k3[i];
  const k4 = f(t + h, y4);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return out;
}

export interface AdaptiveOptions {
  rtol?: number;
  atol?: number;
  hInit?: number;
  hMin?: number;
  hMax?: number;
}

/**
 * Dormand-Prince 5(4) with step-size control. The step size is kept between calls,
 * so one instance should follow one trajectory.
 */
export class Dopri5 {
  h: number;
  private readonly f: Deriv;
  private readonly rtol: number;
  private readonly atol: number;
  private readonly hMin: number;
  private readonly hMax: number;

  constructor(f: Deriv, opts: AdaptiveOptions = {}) {
    this.f = f;
    this.rtol = opts.rtol ?? 1e-10;
    this.atol = opts.atol ?? 1e-6;
    this.h = opts.hInit ?? 1;
    this.hMin = opts.hMin ?? 1e-6;
    this.hMax = opts.hMax ?? Infinity;
  }

  /** Take one accepted step from (t, y), never passing tEnd. Works forward or backward in time. */
  step(t: number, y: number[], tEnd: number): { t: number; y: number[] } {
    const dir = tEnd >= t ? 1 : -1;
    const n = y.length;
    const f = this.f;
    let h = Math.min(Math.abs(this.h), this.hMax);
    const k1 = f(t, y);
    const tmp = new Array<number>(n);
    for (let attempt = 0; attempt < 60; attempt++) {
      const remaining = Math.abs(tEnd - t);
      const last = h >= remaining;
      const hs = dir * (last ? remaining : h);
      for (let i = 0; i < n; i++) tmp[i] = y[i] + hs * (k1[i] / 5);
      const k2 = f(t + hs / 5, tmp);
      for (let i = 0; i < n; i++) tmp[i] = y[i] + hs * ((3 / 40) * k1[i] + (9 / 40) * k2[i]);
      const k3 = f(t + (3 * hs) / 10, tmp);
      for (let i = 0; i < n; i++) tmp[i] = y[i] + hs * ((44 / 45) * k1[i] - (56 / 15) * k2[i] + (32 / 9) * k3[i]);
      const k4 = f(t + (4 * hs) / 5, tmp);
      for (let i = 0; i < n; i++)
        tmp[i] = y[i] + hs * ((19372 / 6561) * k1[i] - (25360 / 2187) * k2[i] + (64448 / 6561) * k3[i] - (212 / 729) * k4[i]);
      const k5 = f(t + (8 * hs) / 9, tmp);
      for (let i = 0; i < n; i++)
        tmp[i] =
          y[i] +
          hs * ((9017 / 3168) * k1[i] - (355 / 33) * k2[i] + (46732 / 5247) * k3[i] + (49 / 176) * k4[i] - (5103 / 18656) * k5[i]);
      const k6 = f(t + hs, tmp);
      const yn = new Array<number>(n);
      for (let i = 0; i < n; i++)
        yn[i] =
          y[i] +
          hs * ((35 / 384) * k1[i] + (500 / 1113) * k3[i] + (125 / 192) * k4[i] - (2187 / 6784) * k5[i] + (11 / 84) * k6[i]);
      const k7 = f(t + hs, yn);
      let err = 0;
      for (let i = 0; i < n; i++) {
        const e =
          hs *
          ((71 / 57600) * k1[i] -
            (71 / 16695) * k3[i] +
            (71 / 1920) * k4[i] -
            (17253 / 339200) * k5[i] +
            (22 / 525) * k6[i] -
            (1 / 40) * k7[i]);
        const sc = this.atol + this.rtol * Math.max(Math.abs(y[i]), Math.abs(yn[i]));
        err += (e / sc) * (e / sc);
      }
      err = Math.sqrt(err / n);
      const hUsed = Math.abs(hs);
      if (err <= 1 || hUsed <= this.hMin) {
        const grow = err > 0 ? Math.min(5, 0.9 * Math.pow(err, -0.2)) : 5;
        // Do not let a short final step shrink the remembered step size.
        if (!last || grow < 1) this.h = Math.min(this.hMax, Math.max(this.hMin, hUsed * grow));
        return { t: last ? tEnd : t + hs, y: yn };
      }
      h = Math.max(this.hMin, hUsed * Math.max(0.2, 0.9 * Math.pow(err, -0.2)));
    }
    throw new Error('Dopri5: step size underflow');
  }
}

/** Integrate from t0 to t1 adaptively. onStep may return true to stop early. */
export function integrateAdaptive(
  f: Deriv,
  t0: number,
  y0: number[],
  t1: number,
  opts: AdaptiveOptions = {},
  onStep?: (t: number, y: number[]) => boolean | void,
): { t: number; y: number[]; steps: number } {
  const solver = new Dopri5(f, opts);
  let t = t0;
  let y = y0;
  let steps = 0;
  while (t !== t1) {
    const s = solver.step(t, y, t1);
    t = s.t;
    y = s.y;
    steps++;
    if (onStep && onStep(t, y) === true) break;
    if (steps > 5_000_000) throw new Error('integrateAdaptive: too many steps');
  }
  return { t, y, steps };
}
