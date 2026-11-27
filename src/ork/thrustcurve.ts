// On-demand lookup of certified motor curves from the ThrustCurve.org public API.
// Only the designation (and optional manufacturer) is sent to the server.

import type { Motor } from '../types';
import { designationKey } from './motors';

const API = 'https://www.thrustcurve.org/api/v1';

/** Give up on a ThrustCurve request that has not answered after this long. */
const FETCH_TIMEOUT_MS = 15_000;

interface SearchHit {
  motorId: string;
  manufacturerAbbrev: string;
  commonName: string;
  /** mm */
  diameter: number;
  /** mm */
  length: number;
  /** g */
  totalWeightG: number;
  /** g */
  propWeightG: number;
}

interface Sample {
  time: number;
  thrust: number;
}

/** POST a JSON body. Returns null on a non-OK status; throws on network errors. */
async function postJson(
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('ThrustCurve did not answer in time.')), FETCH_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one certified motor by designation (and optional manufacturer) from ThrustCurve.org.
 * Returns null on any failure (network error, non-OK status, no matching motor or curve).
 * Never throws.
 */
export async function fetchMotorFromThrustCurve(
  ref: { manufacturer?: string; designation: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Motor | null> {
  try {
    const search: Record<string, unknown> = {
      commonName: designationKey(ref.designation),
      maxResults: 1,
    };
    if (ref.manufacturer) search.manufacturer = ref.manufacturer;

    const s = (await postJson(fetchImpl, 'search.json', search)) as
      | { results?: SearchHit[] }
      | null;
    const hit = s?.results?.[0];
    if (!hit) return null;
    const numeric = [hit.diameter, hit.length, hit.totalWeightG, hit.propWeightG];
    if (!numeric.every(Number.isFinite)) return null;

    const d = (await postJson(fetchImpl, 'download.json', {
      motorIds: [hit.motorId],
      data: 'samples',
      maxResults: 1,
    })) as { results?: { samples?: Sample[] }[] } | null;
    const samples = d?.results?.[0]?.samples;
    if (!samples || samples.length === 0) return null;

    const curve: [number, number][] = samples.map((p) => [p.time, p.thrust]);
    if (curve[0][0] > 0) curve.unshift([0, 0]);
    if (curve[curve.length - 1][1] !== 0) {
      curve.push([curve[curve.length - 1][0] + 0.001, 0]);
    }

    let totalImpulse = 0;
    for (let i = 1; i < curve.length; i++) {
      totalImpulse += 0.5 * (curve[i][1] + curve[i - 1][1]) * (curve[i][0] - curve[i - 1][0]);
    }

    return {
      manufacturer: hit.manufacturerAbbrev,
      designation: hit.commonName,
      diameter: hit.diameter / 1000,
      length: hit.length / 1000,
      totalMass: hit.totalWeightG / 1000,
      propellantMass: hit.propWeightG / 1000,
      curve,
      burnTime: curve[curve.length - 1][0],
      totalImpulse,
      approximate: false,
    };
  } catch {
    return null;
  }
}
