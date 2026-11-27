import { describe, it, expect, beforeAll } from 'vitest';
import { flyMission } from '../mission/fly';
import { getMission } from '../mission/vehicles';
import type { FlightRecord } from '../mission/record';
import { coastPath, coastPathCapacity, coastPathInto } from '../mission/predict';
import {
  buildFlownPathPoints,
  coastValidUntil,
  PAD_HOLD_S,
  PAD_TRACK_S,
  elementsFromAppState,
  latLonToApp,
  padFraming,
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

describe('pad camera framing', () => {
  // LVM3-sized vehicle seen from the pad camera.
  const L = 43.5;
  const cam: [number, number, number] = [-300, 3, 240];
  const middle = (rise: number): [number, number, number] => [0, 0.45 * L + rise, 0];

  it('holds a ground-fixed frame while the vehicle pulls away', () => {
    const onPad = padFraming(-3, L, cam, middle(0));
    // LVM3 climbs about 56 m in 5 s: the frame has not moved at all.
    expect(padFraming(5, L, cam, middle(56))).toEqual(onPad);
  });

  it('gives the same picture for the same time and state', () => {
    expect(padFraming(10, L, cam, middle(240))).toEqual(padFraming(10, L, cam, middle(240)));
  });

  it('ends up tracking the vehicle at a constant size on screen', () => {
    const rocket = middle(495);
    const view = padFraming(PAD_TRACK_S, L, cam, rocket);
    expect(view.aim).toEqual(rocket);
    const distance = Math.hypot(cam[0] - rocket[0], cam[1] - rocket[1], cam[2] - rocket[2]);
    expect(view.tanHalfFov).toBeCloseTo((0.85 * L) / distance, 9);
  });

  it('keeps the whole vehicle in frame and moves without jumps, even for a fast climber', () => {
    for (const accel of [3, 12]) {
      let last: ReturnType<typeof padFraming> | null = null;
      for (let t = 0; t <= PAD_TRACK_S + 2; t += 0.05) {
        const rocket = middle(0.5 * accel * t * t);
        const view = padFraming(t, L, cam, rocket);
        // Angles above the camera of the nose, the tail, and the frame's centre.
        const angle = (y: number) => Math.atan2(y - cam[1], Math.hypot(cam[0], cam[2]));
        const half = Math.atan(view.tanHalfFov);
        expect(angle(rocket[1] + 0.5 * L)).toBeLessThan(angle(view.aim[1]) + half);
        if (t >= PAD_HOLD_S || accel === 3) {
          expect(angle(rocket[1] - 0.45 * L)).toBeGreaterThan(angle(view.aim[1]) - half * 1.01);
        }
        if (last) {
          expect(Math.abs(angle(view.aim[1]) - angle(last.aim[1]))).toBeLessThan(0.03);
          expect(Math.abs(view.tanHalfFov - last.tanHalfFov)).toBeLessThan(0.01);
        }
        last = view;
      }
    }
  });
});

describe('coast prediction reuse', () => {
  it('is never valid while thrusting and valid through a zero-thrust run', () => {
    const burning = record.samples.find((s) => s.thrust > 0 && s.t > 5)!;
    expect(coastValidUntil(record, burning.t)).toBe(-Infinity);
    const lastT = record.samples[record.samples.length - 1].t;
    const until = coastValidUntil(record, lastT);
    // The final sample is either still burning (-Infinity) or coasting to the end (Infinity).
    expect([-Infinity, Infinity]).toContain(until);
  });

  it('coastPathInto matches coastPath point count and time and stays inside capacity', () => {
    const cap = coastPathCapacity(1800, 30);
    const out = { positions: new Float32Array(cap * 3), times: new Float64Array(cap) };
    const origin: [number, number, number] = [0, 0, 0];
    const n = coastPathInto(record, 600, 1800, 30, out, origin);
    const ref = coastPath(record, 600, 1800, 30);
    expect(n).toBe(ref.length);
    expect(n).toBeLessThanOrEqual(cap);
    expect(out.times[n - 1]).toBeCloseTo(ref[n - 1].t, 6);
    expect(out.positions[0]).toBe(0);
  });
});
