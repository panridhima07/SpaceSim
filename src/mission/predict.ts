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
  const snap = snapshotAt(record, t);
  let r = appToEci(snap.pos);
  let v = appToEci(snap.vel);

  const epochJD = record.epochJD ?? 2451545.0;
  const liftoffSimTime = record.liftoffSimTime ?? 0;
  let simT = liftoffSimTime + snap.t;
  const fm = { epochJD };

  const alt0 = toGeodetic(r).alt;
  const points: CoastPoint[] = [{ t: snap.t, pos: eciToApp(r), altitude: alt0 }];

  if (alt0 <= 0 || horizon <= 0 || step <= 0) return points;

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
      points.push({
        t: hi - liftoffSimTime,
        pos: eciToApp(hit.r),
        altitude: Math.max(0, toGeodetic(hit.r).alt),
      });
      break;
    }

    r = res.r;
    v = res.v;
    simT = res.t;
    elapsed += dt;
    points.push({
      t: simT - liftoffSimTime,
      pos: eciToApp(r),
      altitude: nextAlt,
    });
  }

  return points;
}
