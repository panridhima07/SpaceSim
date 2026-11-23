// Browser client for the server-side simulation (api/simulate.ts). Runs the job on the server and
// falls back to running the identical code in the browser when the server cannot be used.

import {
  isSimJobResult,
  parseResultJson,
  parseSimJob,
  runSimJobAsync,
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

function configuredEndpoint(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = env?.VITE_SIM_ENDPOINT;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_ENDPOINT;
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** Why the server could not be used, or the decoded result. Never throws except on user abort. */
async function tryServer(
  req: SimJobRequest,
  opts: RemoteSimOptions,
): Promise<{ ok: true; result: SimJobResult } | { ok: false; reason: string }> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
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
    if (!res.ok) return { ok: false, reason: `server returned ${res.status}` };
    const body = parseResultJson(await res.text());
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
      return { ok: false, reason: 'server reported an error' };
    }
    if (!isSimJobResult(body)) return { ok: false, reason: 'server sent an unexpected response' };
    const { kind, result, durationMs, flights } = body;
    return { ok: true, result: { kind, result, durationMs, flights } };
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
 * Runs the job on our server; falls back to running it in the browser if the server is
 * unreachable, slow (> 20 s), or returns an error. Reports which happened.
 * Rejects with an AbortError only if opts.signal is aborted. If the browser run also fails
 * (the request itself is invalid), the SimJobError from parseSimJob propagates.
 */
export async function runSimJobRemote(
  req: SimJobRequest,
  opts: RemoteSimOptions = {},
): Promise<SimJobResult & { ranOn: 'server' | 'browser' }> {
  if (opts.signal?.aborted) throw abortError();
  const attempt = await tryServer(req, opts);
  if (attempt.ok) return { ...attempt.result, ranOn: 'server' };

  opts.onFallback?.(attempt.reason);
  // Same validation and code path as the server; no wall-clock cap, and sliced so the page stays responsive.
  const result = await runSimJobAsync(parseSimJob(req), { budgetMs: Infinity, signal: opts.signal });
  return { ...result, ranOn: 'browser' };
}
