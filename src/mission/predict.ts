// Predicted unpowered coast path ahead of any instant in a FlightRecord.

import type { Vec3 } from '../types';
import { appToEci, eciToApp } from './adapter';
import { propagate, toGeodetic } from './engine';
import type { FlightRecord } from './record';
import { snapshotAt } from './snapshot';

export interface CoastPoint {
  t: number;
  pos: Vec3;
  altitude: number;
}

/**
 * Propagate the vehicle forward under gravity only from mission time `t` for up to `horizon`
 * seconds, returning points in the app frame every `step` seconds until `horizon` or ground impact.
 */
export function coastPath(record: FlightRecord, t: number, horizon: number, step = 10): CoastPoint[] {
  const points: CoastPoint[] = [];
  coastWalk(record, t, horizon, step, (pt, pos, alt) => {
    points.push({ t: pt, pos, altitude: alt });
  });
  return points;
}

/** Most points coastPath / coastPathInto can return for these arguments (start point plus one per step). */
export function coastPathCapacity(horizon: number, step: number): number {
  return 1 + Math.ceil(Math.max(0, horizon) / Math.max(1e-9, step));
}

export interface CoastBuffers {
  /** xyz triples (length >= 3 * capacity), Earth-fixed and relative to the first point. */
  positions: Float32Array;
  /** Mission time of each point (length >= capacity). */
  times: Float64Array;
}

/**
 * Same walk as coastPath, but writes Earth-fixed positions (rotated by -(angleAtLiftoff + rate * t),
 * relative to the first point) and times into caller-supplied buffers without allocating a point list.
 * Returns the point count and the Earth-fixed position of the first point in `origin`.
 */
export function coastPathInto(
  record: FlightRecord,
  t: number,
  horizon: number,
  step: number,
  out: CoastBuffers,
  origin: Vec3,
): number {
  const a0 = record.earth?.angleAtLiftoff ?? 0;
  const rate = record.earth?.rate ?? 0;
  const cap = out.times.length;
  let n = 0;
  coastWalk(record, t, horizon, step, (pt, pos) => {
    if (n >= cap) return;
    const ang = -(a0 + rate * pt);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const x = pos[0] * c + pos[2] * s;
    const y = pos[1];
    const z = -pos[0] * s + pos[2] * c;
    if (n === 0) {
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
    }
    out.positions[n * 3] = x - origin[0];
    out.positions[n * 3 + 1] = y - origin[1];
    out.positions[n * 3 + 2] = z - origin[2];
    out.times[n] = pt;
    n++;
  });
  return n;
}

function coastWalk(
  record: FlightRecord,
  t: number,
  horizon: number,
  step: number,
  emit: (t: number, pos: Vec3, altitude: number) => void,
): void {
  const snap = snapshotAt(record, t);
  let r = appToEci(snap.pos);
  let v = appToEci(snap.vel);

  const epochJD = record.epochJD ?? 2451545.0;
  const liftoffSimTime = record.liftoffSimTime ?? 0;
  let simT = liftoffSimTime + snap.t;
  const fm = { epochJD };

  const alt0 = toGeodetic(r).alt;
  emit(snap.t, eciToApp(r), alt0);

  if (alt0 <= 0 || horizon <= 0 || step <= 0) return;

  let elapsed = 0;
  while (elapsed < horizon - 1e-9) {
    const dt = Math.min(step, horizon - elapsed);
    const nextSimT = simT + dt;
    const res = propagate(r, v, simT, nextSimT, fm);
    const nextAlt = toGeodetic(res.r).alt;

    if (nextAlt <= 0) {
      let lo = simT;
      let hi = nextSimT;
      let hit = res;
      while (hi - lo > 0.01) {
        const mid = 0.5 * (lo + hi);
        const s = propagate(r, v, simT, mid, fm);
        if (toGeodetic(s.r).alt > 0) {
          lo = mid;
        } else {
          hi = mid;
          hit = s;
        }
      }
      emit(hi - liftoffSimTime, eciToApp(hit.r), Math.max(0, toGeodetic(hit.r).alt));
      break;
    }

    r = res.r;
    v = res.v;
    simT = res.t;
    elapsed += dt;
    emit(simT - liftoffSimTime, eciToApp(r), nextAlt);
  }
}
