// Simulation clock with time warp. Pure TypeScript, no three.js.

import { julianDate } from './ephemeris';

export class SimClock {
  static WARPS: number[] = [1, 2, 5, 10, 50, 100, 1000, 10000, 100000];

  /** Seconds since the epoch start. */
  simTime = 0;
  /** Julian Date of simTime = 0. */
  epochJD: number;
  /** Current time-warp factor, always one of WARPS (or 1). */
  warp = 1;
  paused = false;

  private maxWarp = Infinity;

  constructor(epochJD: number = julianDate(new Date())) {
    this.epochJD = epochJD;
  }

  /** Warp steps permitted under the current max-warp cap. */
  private allowedWarps(): number[] {
    const allowed = SimClock.WARPS.filter((w) => w <= this.maxWarp);
    return allowed.length > 0 ? allowed : [1];
  }

  warpUp(): number {
    const allowed = this.allowedWarps();
    const i = allowed.indexOf(this.warp);
    if (i >= 0 && i < allowed.length - 1) this.warp = allowed[i + 1];
    return this.warp;
  }

  warpDown(): number {
    const allowed = this.allowedWarps();
    const i = allowed.indexOf(this.warp);
    if (i > 0) this.warp = allowed[i - 1];
    return this.warp;
  }

  /**
   * Cap the warp factor (e.g. 10 while in the atmosphere or under thrust). Also prevents
   * warpUp() from exceeding the cap. Call setMaxWarp(Infinity) to lift the cap; the warp is
   * not raised automatically when the cap is lifted.
   */
  setMaxWarp(max: number): void {
    this.maxWarp = max;
    const allowed = this.allowedWarps();
    if (!allowed.includes(this.warp)) {
      this.warp = allowed[allowed.length - 1];
    }
  }

  /**
   * Advance by a real frame time. realDt is clamped to 0.1 s so a stalled tab does not
   * jump the simulation. Returns the simulated seconds advanced (0 when paused).
   */
  tick(realDt: number): number {
    if (this.paused || !(realDt > 0)) return 0;
    const dt = Math.min(realDt, 0.1) * this.warp;
    this.simTime += dt;
    return dt;
  }

  get jd(): number {
    return this.epochJD + this.simTime / 86400;
  }
}
