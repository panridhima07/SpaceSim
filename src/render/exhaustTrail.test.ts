import { describe, it, expect } from 'vitest';
import type { FlightRecord, FlightSample } from '../mission/record';
import { buildExhaustTrail } from './exhaustTrail';

const EARTH_R = 6_378_137;
const N = 40;

/** Vertical-ish ascent: 40 samples at 0.5 s steps, altitude 25 m/s. Earth-fixed point on the equator. */
function makeRecord(opts: { thrust?: number; pos?: [number, number, number] } = {}): FlightRecord {
  const thrust = opts.thrust ?? 1.2e5;
  const samples: FlightSample[] = [];
  for (let i = 0; i < N; i++) {
    const t = i * 0.5;
    const alt = 25 * t;
    const pos = opts.pos
      ? ([opts.pos[0] + alt, opts.pos[1], opts.pos[2]] as [number, number, number])
      : ([EARTH_R + alt, 0, 0] as [number, number, number]);
    samples.push({
      t,
      pos,
      quat: [0, 0, 0, 1],
      vel: [25, 0, 0],
      altitude: alt,
      speed: 25,
      mach: 0.1,
      q: 1000,
      accelG: 1.5,
      mass: 5e4,
      thrust,
      stage: 0,
    });
  }
  // Only the fields the exhaust trail reads are meaningful; the rest of FlightRecord is unused here.
  return {
    source: 'mission',
    samples,
    markers: [],
    earth: { angleAtLiftoff: 0, rate: 0 },
  } as unknown as FlightRecord;
}

describe('buildExhaustTrail', () => {
  it('has no puffs before a record is set', () => {
    const ex = buildExhaustTrail();
    ex.update(5, 1);
    expect(ex.trail.count).toBe(0);
    expect(ex.groundCloud.count).toBe(0);
    ex.dispose();
  });

  it('emits trail and ground-cloud puffs a few seconds into the flight', () => {
    const ex = buildExhaustTrail();
    ex.setRecord(makeRecord(), 2);
    ex.update(5, 1);
    expect(ex.trail.count).toBeGreaterThan(0);
    expect(ex.groundCloud.count).toBeGreaterThan(0);
    ex.dispose();
  });

  it('is scrub-safe: the same time gives the same puffs regardless of history', () => {
    const ex = buildExhaustTrail();
    ex.setRecord(makeRecord(), 2);

    ex.update(10, 1);
    const firstTrail = ex.trail.count;
    const firstGround = ex.groundCloud.count;
    const firstMatrices = Float32Array.from(ex.trail.instanceMatrix.array.slice(0, firstTrail * 16));
    const firstGroundMatrices = Float32Array.from(ex.groundCloud.instanceMatrix.array.slice(0, firstGround * 16));

    ex.update(3, 1);
    ex.update(10, 1);

    expect(ex.trail.count).toBe(firstTrail);
    expect(ex.groundCloud.count).toBe(firstGround);
    expect(Float32Array.from(ex.trail.instanceMatrix.array.slice(0, firstTrail * 16))).toEqual(firstMatrices);
    expect(Float32Array.from(ex.groundCloud.instanceMatrix.array.slice(0, firstGround * 16))).toEqual(firstGroundMatrices);
    ex.dispose();
  });

  it('emits no column puffs when every sample has zero thrust', () => {
    const ex = buildExhaustTrail();
    ex.setRecord(makeRecord({ thrust: 0 }), 2);
    ex.update(10, 1);
    expect(ex.trail.count).toBe(0);
    ex.dispose();
  });

  it('produces finite instance matrices when the path is over the pole', () => {
    // Over the pole the east vector is degenerate; the trail must still produce finite numbers.
    const ex = buildExhaustTrail();
    const rec = makeRecord({ pos: [0, 0, 0] });
    // Rebuild the samples so they climb along +Y (the app frame's pole axis).
    rec.samples = rec.samples.map((s) => ({ ...s, pos: [0, EARTH_R + s.altitude, 0] as [number, number, number] }));
    ex.setRecord(rec, 2);
    ex.update(8, 1);
    expect(ex.trail.count).toBeGreaterThan(0);
    const arr = ex.trail.instanceMatrix.array;
    for (let i = 0; i < ex.trail.count * 16; i++) expect(Number.isFinite(arr[i])).toBe(true);
    ex.dispose();
  });
});
