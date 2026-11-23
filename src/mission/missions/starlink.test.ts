import { beforeAll, describe, expect, it } from 'vitest';
import { flyMission } from '../fly';
import type { FlightRecord } from '../record';
import { STARLINK_MISSION, STARLINK_PAYLOAD } from './starlink';

let record: FlightRecord;

beforeAll(() => {
  record = flyMission(STARLINK_MISSION);
}, 60_000);

describe('flyMission falcon9-starlink', () => {
  it('reaches the target orbit nominally', () => {
    expect(record.reachedTarget).toBe(true);
    expect(record.outcome?.outcome).toBe('nominal');
  }, 60_000);

  it('reaches perigee and apogee within 15 km of the target', () => {
    const orbit = record.orbit!;
    expect(Math.abs(orbit.periapsis - 365e3)).toBeLessThan(15e3);
    expect(Math.abs(orbit.apoapsis - 373e3)).toBeLessThan(15e3);
  }, 60_000);

  it('reaches the 43 degree inclination within 0.3 degrees', () => {
    expect(Math.abs(record.orbit!.inclinationDeg - 43)).toBeLessThan(0.3);
  }, 60_000);

  it('separates stage 1 within 15 s of the real separation time', () => {
    const sep = record.stageSeparation![0]!;
    expect(sep).not.toBeNull();
    expect(Math.abs(sep - 150)).toBeLessThan(15);
  }, 60_000);

  it('has liftoff thrust-to-weight between 1.2 and 1.6', () => {
    const marker = record.markers.find((m) => /Liftoff, thrust-to-weight/.test(m.label));
    expect(marker, 'missing liftoff marker').toBeDefined();
    const tw = Number(/thrust-to-weight ([\d.]+)/.exec(marker!.label)![1]);
    expect(tw).toBeGreaterThan(1.2);
    expect(tw).toBeLessThan(1.6);
  }, 60_000);

  it('releases the payload and separates it at the expected relative speed', () => {
    const pay = STARLINK_MISSION.payload!;
    expect(record.payloadSeparation).not.toBeNull();
    expect(record.payloadSeparation!).toBeGreaterThan(0);
    const last = record.samples[record.samples.length - 1];
    expect(last.payloadOffset).toBeDefined();
    const gap = Math.hypot(...last.payloadOffset!);
    const tSinceSep = last.t - record.payloadSeparation!;
    expect(tSinceSep).toBeGreaterThan(0);
    const speed = gap / tSinceSep;
    expect(speed).toBeGreaterThan(pay.springSpeed * 0.9);
    expect(speed).toBeLessThan(pay.springSpeed * 1.1);
    expect(STARLINK_PAYLOAD.count).toBe(21);
  }, 60_000);

  for (const fc of STARLINK_MISSION.failureCases ?? []) {
    it(`flies failure case ${fc.id} without throwing`, () => {
      const failed = flyMission(STARLINK_MISSION, { failureCase: fc.id });
      expect(failed.failureCase).toBe(fc.id);
      expect(failed.samples.length).toBeGreaterThan(0);
      expect(failed.outcome).toBeDefined();
    }, 60_000);
  }
});
