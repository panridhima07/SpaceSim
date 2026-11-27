import { describe, it, expect, vi } from 'vitest';
import { fetchMotorFromThrustCurve } from './thrustcurve';

const SEARCH_HIT = {
  motorId: 'abc123',
  manufacturerAbbrev: 'Estes',
  commonName: 'C6',
  diameter: 18,
  length: 70,
  totalWeightG: 24,
  propWeightG: 12.5,
};

// Samples start at t > 0 and end with non-zero thrust, so the fetcher must pad both ends.
const SAMPLES = [
  { time: 0.05, thrust: 10 },
  { time: 0.1, thrust: 12 },
  { time: 1.0, thrust: 5 },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockApi(search: unknown, download: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/search.json')) return jsonResponse(search);
    if (url.endsWith('/download.json')) return jsonResponse(download);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('fetchMotorFromThrustCurve', () => {
  it('builds a certified Motor in SI units on success', async () => {
    const fetchImpl = mockApi(
      { results: [SEARCH_HIT] },
      { results: [{ samples: SAMPLES }] },
    );

    const m = await fetchMotorFromThrustCurve({ designation: 'C6-5' }, fetchImpl);

    expect(m).not.toBeNull();
    expect(m!.manufacturer).toBe('Estes');
    expect(m!.designation).toBe('C6');
    expect(m!.approximate).toBe(false);
    expect(m!.diameter).toBeCloseTo(0.018, 9);
    expect(m!.length).toBeCloseTo(0.07, 9);
    expect(m!.totalMass).toBeCloseTo(0.024, 9);
    expect(m!.propellantMass).toBeCloseTo(0.0125, 9);

    expect(m!.curve[0]).toEqual([0, 0]);
    expect(m!.curve[m!.curve.length - 1][1]).toBe(0);
    expect(m!.burnTime).toBeCloseTo(m!.curve[m!.curve.length - 1][0], 9);

    // Trapezoid over the padded curve: [0,0],[0.05,10],[0.1,12],[1.0,5],[1.001,0].
    const expected = 0.05 * 5 + 0.05 * 11 + 0.9 * 8.5 + 0.001 * 2.5;
    expect(m!.totalImpulse).toBeCloseTo(expected, 6);
  });

  it('sends the normalised designation, manufacturer and download request', async () => {
    const fetchImpl = mockApi(
      { results: [SEARCH_HIT] },
      { results: [{ samples: SAMPLES }] },
    );

    await fetchMotorFromThrustCurve({ manufacturer: 'Estes', designation: 'C6-5' }, fetchImpl);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(2);
    const [searchUrl, searchInit] = calls[0];
    expect(searchUrl).toBe('https://www.thrustcurve.org/api/v1/search.json');
    expect(searchInit.method).toBe('POST');
    expect(JSON.parse(searchInit.body as string)).toEqual({
      commonName: 'C6',
      manufacturer: 'Estes',
      maxResults: 1,
    });
    const [downloadUrl, downloadInit] = calls[1];
    expect(downloadUrl).toBe('https://www.thrustcurve.org/api/v1/download.json');
    expect(JSON.parse(downloadInit.body as string)).toEqual({
      motorIds: ['abc123'],
      data: 'samples',
      maxResults: 1,
    });
  });

  it('returns null on a 429 rate limit', async () => {
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    expect(await fetchMotorFromThrustCurve({ designation: 'C6' }, fetchImpl)).toBeNull();
  });

  it('returns null when the search has no results', async () => {
    const fetchImpl = mockApi({ results: [] }, { results: [] });
    expect(await fetchMotorFromThrustCurve({ designation: 'Z99' }, fetchImpl)).toBeNull();
  });

  it('returns null when the download has no samples', async () => {
    const fetchImpl = mockApi({ results: [SEARCH_HIT] }, { results: [{ samples: [] }] });
    expect(await fetchMotorFromThrustCurve({ designation: 'C6' }, fetchImpl)).toBeNull();
  });

  it('returns null instead of throwing on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await fetchMotorFromThrustCurve({ designation: 'C6' }, fetchImpl)).toBeNull();
  });
});
