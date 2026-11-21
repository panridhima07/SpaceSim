import { describe, expect, it } from 'vitest';
import { SimClock } from './clock';

describe('SimClock', () => {
  it('warp steps through the table and stops at the ends', () => {
    const c = new SimClock(2451545);
    expect(c.warp).toBe(1);
    expect(c.warpUp()).toBe(2);
    expect(c.warpUp()).toBe(5);
    c.warp = 100000;
    expect(c.warpUp()).toBe(100000);
    c.warp = 1;
    expect(c.warpDown()).toBe(1);
  });

  it('setMaxWarp clamps the current warp and blocks warpUp past the cap', () => {
    const c = new SimClock(2451545);
    c.warp = 1000;
    c.setMaxWarp(10);
    expect(c.warp).toBe(10);
    c.warpUp();
    expect(c.warp).toBe(10);
    c.setMaxWarp(Infinity);
    c.warpUp();
    expect(c.warp).toBe(50);
  });

  it('tick returns realDt * warp and advances simTime', () => {
    const c = new SimClock(2451545);
    c.warp = 10;
    expect(c.tick(0.05)).toBeCloseTo(0.5, 12);
    expect(c.simTime).toBeCloseTo(0.5, 12);
  });

  it('tick clamps realDt to 0.1 s', () => {
    const c = new SimClock(2451545);
    expect(c.tick(5)).toBeCloseTo(0.1, 12);
    expect(c.tick(-1)).toBe(0);
    expect(c.tick(NaN)).toBe(0);
  });

  it('paused clock returns 0 and does not advance', () => {
    const c = new SimClock(2451545);
    c.paused = true;
    expect(c.tick(0.05)).toBe(0);
    expect(c.simTime).toBe(0);
  });

  it('jd follows simTime', () => {
    const c = new SimClock(2451545);
    c.simTime = 86400;
    expect(c.jd).toBeCloseTo(2451546, 9);
  });
});
