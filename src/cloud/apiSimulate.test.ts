// Tests for api/simulate.ts. Lives here because vitest only includes src/**/*.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromRocketModel } from '../builder/design';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import handler, { config } from '../../api/simulate';
import { isFlightJobResult, isMissionJobResult, parseResultJson } from './simJob';

const design = JSON.parse(JSON.stringify(fromRocketModel(parseOrkXml(SAMPLE_ORK_XML)))) as unknown;
const validBody = JSON.stringify({ kind: 'stress', design, motors: { motor: { designation: 'C6' } }, config: {} });

let ipCounter = 0;
/** Each test uses its own IP so the in-memory rate limit does not leak between tests. */
function post(body: string, headers: Record<string, string> = {}, ip = `10.0.0.${++ipCounter}`): Request {
  return new Request('https://astra.test/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...headers },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('api/simulate', () => {
  it('declares a 60 s max duration', () => {
    expect(config.maxDuration).toBe(60);
  });

  it('answers OPTIONS with 204 and no CORS grants', async () => {
    const res = await handler.fetch(new Request('https://astra.test/api/simulate', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects GET with 405', async () => {
    const res = await handler.fetch(new Request('https://astra.test/api/simulate'));
    expect(res.status).toBe(405);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects the wrong content type with 415', async () => {
    const res = await handler.fetch(post('x', { 'content-type': 'text/plain' }));
    expect(res.status).toBe(415);
  });

  it('rejects an oversize body with 413 (declared and actual)', async () => {
    const declared = await handler.fetch(post('{}', { 'content-length': '2000000' }));
    expect(declared.status).toBe(413);
    const actual = await handler.fetch(post(JSON.stringify({ pad: 'a'.repeat(1_100_000) })));
    expect(actual.status).toBe(413);
  });

  it('rejects bad JSON with 400', async () => {
    const res = await handler.fetch(post('{nope'));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('rejects an invalid job with 400 and a message', async () => {
    const res = await handler.fetch(post(JSON.stringify({ kind: 'stress' })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('rejects an invalid bearer token with 401', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    const spy = vi.fn(async () => new Response('{"msg":"bad"}', { status: 401 }));
    vi.stubGlobal('fetch', spy);
    const res = await handler.fetch(post(validBody, { authorization: 'Bearer aaa.bbb.ccc' }));
    expect(res.status).toBe(401);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/auth/v1/user');
    expect((init.headers as Record<string, string>).apikey).toBe('anon');
  });

  it('refuses a token that is not JWT-shaped without calling Supabase', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await handler.fetch(post(validBody, { authorization: 'Bearer notajwt' }));
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a signed-in request as a guest when the sign-in check cannot run', async () => {
    vi.stubEnv('SIM_JOB_BUDGET_MS', '55000');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const body = JSON.stringify({ kind: 'flight', design, motors: { motor: { designation: 'C6' } }, config: {} });
    const res = await handler.fetch(post(body, { authorization: 'Bearer hdr.payload.sig' }));
    expect(res.status).toBe(200);
  }, 60_000);

  it('runs a valid job as a guest and as a signed-in user', async () => {
    // A 19-flight stress test takes about 6 s alone but can pass the 25 s production budget
    // when the whole suite runs in parallel; this test checks the handler, not the budget.
    vi.stubEnv('SIM_JOB_BUDGET_MS', '55000');
    const res = await handler.fetch(post(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('stress');
    expect(body.flights).toBe(19);
    expect(body.result.wind).toHaveLength(7);
    expect(typeof body.durationMs).toBe('number');

    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"u1"}', { status: 200 })));
    const signed = await handler.fetch(post(validBody, { authorization: 'Bearer hdr.payload.sig' }));
    expect(signed.status).toBe(200);
  }, 120_000);

  it('runs a flight job and a mission job', async () => {
    vi.stubEnv('SIM_JOB_BUDGET_MS', '55000');
    const flight = await handler.fetch(
      post(JSON.stringify({ kind: 'flight', design, motors: { motor: { designation: 'C6' } }, config: {} })),
    );
    expect(flight.status).toBe(200);
    expect(flight.headers.get('access-control-allow-origin')).toBeNull();
    const flightBody = parseResultJson(await flight.text()) as { ok: boolean };
    expect(flightBody.ok).toBe(true);
    expect(isFlightJobResult(flightBody)).toBe(true);

    const mission = await handler.fetch(
      post(JSON.stringify({ kind: 'mission', mission: 'lvm3-m4', options: { failureCase: 'gimbal-lock', destructive: true } })),
    );
    expect(mission.status).toBe(200);
    const text = await mission.text();
    expect(text.length).toBeLessThan(4_000_000);
    const missionBody = parseResultJson(text);
    expect(isMissionJobResult(missionBody)).toBe(true);
  }, 120_000);

  it('rejects invalid flight and mission jobs with 400', async () => {
    for (const body of [
      { kind: 'flight' },
      { kind: 'flight', design, motors: { motor: { designation: 'C6' }, stages: 'x' } },
      { kind: 'mission', mission: 'nope' },
      { kind: 'mission', mission: 'lvm3-m4', options: { sampleInterval: 0.000001 } },
      { kind: 'other' },
    ]) {
      expect((await handler.fetch(post(JSON.stringify(body)))).status).toBe(400);
    }
  });

  it('rate limits after 30 requests from one IP', async () => {
    const ip = '203.0.113.9';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      // Invalid jobs are cheap and still count.
      statuses.push((await handler.fetch(post('{}', {}, ip))).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
