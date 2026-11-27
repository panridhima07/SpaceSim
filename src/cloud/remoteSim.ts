// Browser client for the server-side simulation (api/simulate.ts). On the website a job runs on
// the server, falling back to the identical code in the browser when the server cannot be used. In
// the Android app the physics always runs on the device.

import { Capacitor } from '@capacitor/core';
import {
  isSimJobResult,
  parseResultJson,
  parseSimJob,
  runSimJobAsync,
  type AnyJobRequest,
  type SimJobRequest,
  type SimJobResult,
} from './simJob';

export interface RemoteSimOptions {
  /** Supabase access token; sent as a bearer header when given. Guests may omit it. */
  accessToken?: string;
  /** Default: VITE_SIM_ENDPOINT when set (Android build), else /api/simulate. */
  endpoint?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onFallback?: (reason: string) => void;
  /** Server wait before falling back, ms. Default 20 000. */
  timeoutMs?: number;
}

export const SERVER_TIMEOUT_MS = 20_000;
export const DEFAULT_ENDPOINT = '/api/simulate';

/** The website computes on the server; the native app computes on the device. */
export function runsOnServer(): boolean {
  return !Capacitor.isNativePlatform();
}

function configuredEndpoint(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = env?.VITE_SIM_ENDPOINT;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_ENDPOINT;
}

let busyUntil = 0;

/** Test helper: forget a previous 429. */
export function resetServerBusyForTests(): void {
  busyUntil = 0;
}

export function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/**
 * Send one job to the server. Gives the decoded response, or why the server could not be used.
 * Never throws except on user abort.
 */
export async function postSimJob<T>(
  req: AnyJobRequest,
  isResult: (body: unknown) => body is T,
  opts: RemoteSimOptions = {},
): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  if (opts.signal?.aborted) throw abortError();
  // A clock set backwards must not stretch the window past the 600 s cap.
  if (busyUntil - Date.now() > 600_000) busyUntil = 0;
  if (Date.now() < busyUntil) {
    return { ok: false, reason: `server busy, retry in ${Math.ceil((busyUntil - Date.now()) / 1000)}s` };
  }
  const doFetch =opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!doFetch) return { ok: false, reason: 'fetch is unavailable' };

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? SERVER_TIMEOUT_MS);
  const onAbort = (): void => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
    const res = await doFetch(opts.endpoint ?? configuredEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: ctl.signal,
    });
    if (!res.ok) {
      if (res.status === 429) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const s = Number.isFinite(ra) && ra > 0 ? Math.min(600, Math.max(1, ra)) : 60;
        busyUntil = Date.now() + s * 1000;
      }
      let detail = '';
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string' && j.error) detail = j.error.slice(0, 200);
      } catch {
        /* body is not JSON */
      }
      return { ok: false, reason: detail ? `server returned ${res.status}: ${detail}` : `server returned ${res.status}` };
    }
    const body = parseResultJson(await res.text());
    if (opts.signal?.aborted) throw abortError();
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
      return { ok: false, reason: 'server reported an error' };
    }
    if (!isResult(body)) return { ok: false, reason: 'server sent an unexpected response' };
    return { ok: true, result: body };
  } catch (e) {
    if (opts.signal?.aborted) throw abortError();
    if (timedOut) return { ok: false, reason: `server took longer than ${(opts.timeoutMs ?? SERVER_TIMEOUT_MS) / 1000} s` };
    return { ok: false, reason: e instanceof Error ? `network error: ${e.message}` : 'network error' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs the stress test on our server; falls back to running it in the browser if the server is
 * unreachable, slow (> 20 s), or returns an error. In the native app it runs on the device and
 * nothing is sent. Reports which happened.
 * Rejects with an AbortError only if opts.signal is aborted. If the local run also fails
 * (the request itself is invalid), the SimJobError from parseSimJob propagates.
 */
export async function runSimJobRemote(
  req: SimJobRequest,
  opts: RemoteSimOptions = {},
): Promise<SimJobResult & { ranOn: 'server' | 'browser' }> {
  if (opts.signal?.aborted) throw abortError();
  if (runsOnServer()) {
    const attempt = await postSimJob(req, isSimJobResult, opts);
    if (attempt.ok) {
      const { kind, result, durationMs, flights } = attempt.result;
      return { kind, result, durationMs, flights, ranOn: 'server' };
    }
    opts.onFallback?.(attempt.reason);
  }
  // Same validation and code path as the server; no wall-clock cap, and sliced so the page stays responsive.
  const result = await runSimJobAsync(parseSimJob(req), { budgetMs: Infinity, signal: opts.signal });
  return { ...result, ranOn: 'browser' };
}
