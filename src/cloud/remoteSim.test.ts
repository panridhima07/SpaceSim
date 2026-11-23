import { describe, expect, it, vi } from 'vitest';
import { fromRocketModel } from '../builder/design';
import { parseOrkXml } from '../ork/parser';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { SimJobError, stringifyResult, type SimJobRequest, type SimJobResult } from './simJob';
import { runSimJobRemote } from './remoteSim';

const design = JSON.parse(JSON.stringify(fromRocketModel(parseOrkXml(SAMPLE_ORK_XML)))) as unknown;
const req: SimJobRequest = {
  kind: 'stress',
  design,
  motors: { motor: { designation: 'C6' } },
  config: {},
};

// A tiny fake report: the client only shape-checks it.
const fake: SimJobResult = {
  kind: 'stress',
  result: {
    wind: [], railAngle: [], delay: [], maxSafeWind: null, bestDelay: null, summary: ['ok'],
  },
  durationMs: 5,
  flights: 19,
};

const okResponse = (): Response => new Response(stringifyResult({ ok: true, ...fake }), { status: 200 });

/** A fetch that never answers until its signal aborts. */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
      }),
  ) as unknown as typeof fetch;
}

describe('runSimJobRemote', () => {
  it('uses the server result when it succeeds, and sends the bearer token', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const onFallback = vi.fn();
    const out = await runSimJobRemote(req, { fetchImpl: fetchImpl as unknown as typeof fetch, accessToken: 'tok123', onFallback });
    expect(out.ranOn).toBe('server');
    expect(out.flights).toBe(19);
    expect(onFallback).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/simulate');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok123');
    expect(init.method).toBe('POST');
  });

  it('sends no authorization header for guests and honours a custom endpoint', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await runSimJobRemote(req, { fetchImpl: fetchImpl as unknown as typeof fetch, endpoint: 'https://x.test/api/simulate' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/api/simulate');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('falls back to the browser on a server 500', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":false}', { status: 500 }));
    const onFallback = vi.fn();
    const out = await runSimJobRemote(req, { fetchImpl: fetchImpl as unknown as typeof fetch, onFallback });
    expect(out.ranOn).toBe('browser');
    expect(out.flights).toBe(19);
    expect(out.result.wind.length).toBeGreaterThan(0);
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('500'));
  }, 120_000);

  it('falls back on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const onFallback = vi.fn();
    const out = await runSimJobRemote(req, { fetchImpl: fetchImpl as unknown as typeof fetch, onFallback });
    expect(out.ranOn).toBe('browser');
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('network error'));
  }, 120_000);

  it('falls back on timeout', async () => {
    const onFallback = vi.fn();
    const out = await runSimJobRemote(req, { fetchImpl: hangingFetch(), onFallback, timeoutMs: 30 });
    expect(out.ranOn).toBe('browser');
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('longer than'));
  }, 120_000);

  it('rejects with AbortError, without falling back, when the caller aborts', async () => {
    const ctl = new AbortController();
    const onFallback = vi.fn();
    const p = runSimJobRemote(req, { fetchImpl: hangingFetch(), signal: ctl.signal, onFallback });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('surfaces an invalid request from the browser fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }));
    await expect(
      runSimJobRemote({ ...req, design: null }, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SimJobError);
  });
});
