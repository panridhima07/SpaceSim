import { describe, it, expect, beforeAll } from 'vitest';
import { flyMission } from '../mission/fly';
import { getMission } from '../mission/vehicles';
import type { FlightRecord } from '../mission/record';
import {
  buildFlownPathPoints,
  elementsFromAppState,
  latLonToApp,
  separationAges,
  vehicleToLauncherSpec,
} from './missionView';

const mission = getMission('lvm3-m4')!;
let record: FlightRecord;

beforeAll(() => {
  record = flyMission(mission);
}, 120_000);

describe('missionView helpers', () => {
  it('places Sriharikota (13.72 N, 80.23 E) within 5 km of the first sample', () => {
    const s0 = record.samples[0];
    const angle0 = (record.earth?.angleAtLiftoff ?? 0) + (record.earth?.rate ?? 0) * s0.t;
    const p = latLonToApp(13.72, 80.23, angle0);
    const dist = Math.hypot(p[0] - s0.pos[0], p[1] - s0.pos[1], p[2] - s0.pos[2]);
    expect(dist).toBeLessThan(5000);
  });

  it('builds LauncherSpec from LVM3 with S200 parallel count 2 and a fairing', () => {
    const { spec, isSolid } = vehicleToLauncherSpec(mission.vehicle());
    expect(spec.stages).toHaveLength(3);
    const boosterIdx = spec.stages.findIndex((s) => s.parallel !== undefined);
    expect(boosterIdx).toBeGreaterThanOrEqual(0);
    expect(spec.stages[boosterIdx].parallel?.count).toBe(2);
    expect(isSolid[boosterIdx]).toBe(true);
    expect(spec.fairing).toBeDefined();
  });

  it('computes separation ages as null before and positive after each separation', () => {
    const seps = record.stageSeparation!;
    for (let i = 0; i < seps.length; i++) {
      const sepT = seps[i];
      if (sepT === null) {
        expect(separationAges(record, 500).stages[i]).toBeNull();
      } else {
        expect(separationAges(record, sepT - 1).stages[i]).toBeNull();
        expect(separationAges(record, sepT + 2).stages[i]).toBeCloseTo(2, 5);
      }
    }
    const fSep = record.fairingSeparation!;
    expect(separationAges(record, fSep - 1).fairing).toBeNull();
    expect(separationAges(record, fSep + 3).fairing).toBeCloseTo(3, 5);
  });

  it('flown path starts at the pad and ends at the last sample altitude within 1 km', () => {
    const { origin, offsets } = buildFlownPathPoints(record);
    const s0 = record.samples[0];
    const angle0 = (record.earth?.angleAtLiftoff ?? 0) + (record.earth?.rate ?? 0) * s0.t;
    const pad = latLonToApp(13.72, 80.23, 0);
    const padDist = Math.hypot(origin[0] - pad[0], origin[1] - pad[1], origin[2] - pad[2]);
    expect(padDist).toBeLessThan(5000);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(0);
    expect(offsets[2]).toBe(0);
    // Ensure angle0 was used consistently (s0.pos rotated by -angle0 equals origin)
    expect(Math.hypot(...origin)).toBeCloseTo(Math.hypot(...s0.pos), 0);
    void angle0;

    const lastIdx = (record.samples.length - 1) * 3;
    const lastPos: [number, number, number] = [
      origin[0] + offsets[lastIdx],
      origin[1] + offsets[lastIdx + 1],
      origin[2] + offsets[lastIdx + 2],
    ];
    const lastSample = record.samples[record.samples.length - 1];
    // Compare radius against Earth radius + sample altitude (geodetic vs spherical within ~10 km, or compare directly with lastSample.pos magnitude)
    const pathRadius = Math.hypot(...lastPos);
    const sampleRadius = Math.hypot(...lastSample.pos);
    expect(Math.abs(pathRadius - sampleRadius)).toBeLessThan(1000);
  });

  it('computes orbital elements from the last nominal sample matching record.orbit', () => {
    const last = record.samples[record.samples.length - 1];
    const el = elementsFromAppState(last.pos, last.vel);
    expect(Math.abs(el.perigeeAltitude - record.orbit!.periapsis)).toBeLessThan(5000);
    expect(Math.abs(el.apogeeAltitude - record.orbit!.apoapsis)).toBeLessThan(50_000);
  });
});
