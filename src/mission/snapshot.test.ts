import { beforeAll, describe, expect, it } from 'vitest';
import { flyMission } from './fly';
import { coastPath } from './predict';
import type { FlightRecord } from './record';
import { snapshotAt } from './snapshot';
import { getMission } from './vehicles';

const mission = getMission('lvm3-m4')!;
let record: FlightRecord;

beforeAll(() => {
  record = flyMission(mission);
}, 60_000);

describe('snapshotAt', () => {
  it('throws on an empty record', () => {
    const empty: FlightRecord = { source: 'mission', samples: [], markers: [] };
    expect(() => snapshotAt(empty, 0)).toThrow();
  });

  it('matches an exact sample field for field', () => {
    const target = record.samples[Math.floor(record.samples.length / 2)];
    const snap = snapshotAt(record, target.t);
    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      expect(snap[key]).toEqual(target[key]);
    }
  });

  it('interpolates altitude linearly and normalises slerped quaternion halfway between samples', () => {
    const a = record.samples[100];
    const b = record.samples[101];
    const midT = 0.5 * (a.t + b.t);
    const snap = snapshotAt(record, midT);
    expect(snap.altitude).toBeCloseTo(0.5 * (a.altitude + b.altitude), 6);
    const qNorm = Math.hypot(...snap.quat);
    expect(Math.abs(qNorm - 1)).toBeLessThan(1e-9);
  });

  it('captures max-Q around 57.3 s', () => {
    const snap = snapshotAt(record, 57.3);
    expect(snap.q).toBeGreaterThanOrEqual(38_000);
    expect(snap.q).toBeLessThanOrEqual(45_000);
  });

  it('reports upper-stage closed-loop flight and upcoming C25 cutoff at 400 s', () => {
    const snap = snapshotAt(record, 400);
    expect(snap.stage).toBe(2);
    expect(snap.phase).toBe('closedLoop');
    expect(snap.propellant![0]).toBe(0);
    expect(snap.nextEvent).not.toBeNull();
    expect(snap.nextEvent!.label).toMatch(/C25.*cutoff/i);
    expect(snap.nextEvent!.in).toBeGreaterThanOrEqual(500);
    expect(snap.nextEvent!.in).toBeLessThanOrEqual(570);
  });

  it('clamps to the first and last samples outside the record time range', () => {
    const first = record.samples[0];
    const last = record.samples[record.samples.length - 1];
    const before = snapshotAt(record, -5);
    const after = snapshotAt(record, 1e9);
    for (const key of Object.keys(first) as (keyof typeof first)[]) {
      expect(before[key]).toEqual(first[key]);
    }
    for (const key of Object.keys(last) as (keyof typeof last)[]) {
      expect(after[key]).toEqual(last[key]);
    }
  });

  it('places t = 0 at Sriharikota', () => {
    const snap = snapshotAt(record, 0);
    expect(Math.abs(snap.latDeg! - 13.72)).toBeLessThan(0.05);
    expect(Math.abs(snap.lonDeg! - 80.23)).toBeLessThan(0.05);
  });
});

describe('iipTrack', () => {
  it('tracks the instantaneous impact point across the Bay of Bengal until orbital insertion', () => {
    const track = record.iipTrack!;
    expect(track).toBeDefined();
    expect(track.length).toBeGreaterThanOrEqual(60);
    expect(track.length).toBeLessThanOrEqual(90);

    expect(Math.abs(track[0].latDeg - 13.72)).toBeLessThan(0.1);
    expect(Math.abs(track[0].lonDeg - 80.23)).toBeLessThan(0.1);

    let nearest125 = track[0];
    for (const pt of track) {
      if (Math.abs(pt.t - 125) < Math.abs(nearest125.t - 125)) nearest125 = pt;
    }
    expect(nearest125.lonDeg).toBeGreaterThanOrEqual(82.7);
    expect(nearest125.lonDeg).toBeLessThanOrEqual(84.7);
    expect(nearest125.latDeg).toBeGreaterThanOrEqual(13.4);
    expect(nearest125.latDeg).toBeLessThanOrEqual(13.9);

    for (let i = 1; i < track.length; i++) {
      expect(track[i].lonDeg).toBeGreaterThanOrEqual(track[i - 1].lonDeg);
    }
    expect(track[track.length - 1].t).toBeLessThan(800);
    expect(snapshotAt(record, 900).iip).toBeNull();
  });
});

describe('coastPath', () => {
  it('re-enters from T+600 s with apogee between 270 and 320 km', () => {
    const snap = snapshotAt(record, 600);
    const path = coastPath(record, 600, 3000);
    expect(path.length).toBeGreaterThan(2);

    const dx = path[0].pos[0] - snap.pos[0];
    const dy = path[0].pos[1] - snap.pos[1];
    const dz = path[0].pos[2] - snap.pos[2];
    expect(Math.hypot(dx, dy, dz)).toBeLessThan(1);

    const last = path[path.length - 1];
    expect(last.altitude).toBeLessThan(100);
    expect(last.t - 600).toBeLessThan(3000);

    const peakAlt = Math.max(...path.map((p) => p.altitude));
    expect(peakAlt).toBeGreaterThanOrEqual(270e3);
    expect(peakAlt).toBeLessThanOrEqual(320e3);
  });

  it('stays above 160 km when coasting from the end of the nominal flight', () => {
    const lastT = record.samples[record.samples.length - 1].t;
    const path = coastPath(record, lastT, 3000);
    expect(path.length).toBeGreaterThan(10);
    const minAlt = Math.min(...path.map((p) => p.altitude));
    expect(minAlt).toBeGreaterThanOrEqual(160e3);
  });
});
