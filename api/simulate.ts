// POST /api/simulate: runs a non-interactive simulation job (stress test, single flight or
// mission) on the server.
// Vercel Node.js runtime, Web Standard `fetch` handler (export default { fetch }).
//
// Same-origin only: no CORS headers are ever sent. Everything in the body is hostile and goes
// through parseAnyJob. Sign-in is optional; a bearer token, when present, must verify with Supabase.

import { SimBudgetError, SimJobError, parseAnyJob, runAnyJob, stringifyResult } from '../src/cloud/simJob';

export const config = { maxDuration: 60 };

const MAX_BODY_BYTES = 1_000_000; // 1 MB
// Every launch and every mission case is a job, so ordinary use is a request every few seconds,
// more while someone is tuning a design. 30 a minute leaves room for that while still capping what
// one address can cost. A client that hits the limit runs the physics on its own device instead.
const RATE_LIMIT = 30; // jobs
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 5000;
const AUTH_TIMEOUT_MS = 5000;
const MAX_TOKEN_CHARS = 4096;
// Kept under the client's own timeouts (src/cloud/runPhysics.ts FLIGHT_TIMEOUT_MS 12 s,
// src/cloud/remoteSim.ts SERVER_TIMEOUT_MS 20 s), so the server never burns CPU on a job the
// client has already given up on.
const JOB_BUDGET_MS = { flight: 10_000, stress: 18_000, mission: 18_000 } as const;
// A Supabase access token is a JWT: three base64url parts. Anything else is refused without a
// network call.
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

// Per-IP rate limit. In memory, so it is per function instance and best-effort only: instances
// scale out and restart, each with its own counters. It blunts casual abuse, nothing more.
const hits = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > MAX_TRACKED_IPS) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
    }
    // Still too many live entries: drop the oldest.
    while (hits.size > MAX_TRACKED_IPS) hits.delete(hits.keys().next().value as string);
  }
  return false;
}

function clientIp(req: Request): string {
  const h = req.headers;
  // x-vercel-forwarded-for is set by the platform; x-forwarded-for can be sent by the client, so
  // it is not used (off Vercel, everyone shares one 'unknown' bucket: best-effort only).
  const v = h.get('x-vercel-forwarded-for') ?? h.get('x-real-ip');
  return v ? v.split(',')[0].trim() || 'unknown' : 'unknown';
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(stringifyResult(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

const fail = (status: number, error: string, extra?: Record<string, string>): Response =>
  json(status, { ok: false, error }, extra);

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

/**
 * Wall-clock budget for one job. SIM_JOB_BUDGET_MS can change it (tests on a busy machine
 * raise it), but it stays under the function's 60 s maxDuration.
 */
function jobBudgetMs(kind: keyof typeof JOB_BUDGET_MS): number {
  const v = Number(env('SIM_JOB_BUDGET_MS'));
  return Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, 1000), 55_000) : JOB_BUDGET_MS[kind];
}

/**
 * null = go ahead; otherwise the error response. Sign-in is optional and unlocks nothing yet, so
 * only a token Supabase definitely rejects is refused. When the check cannot run (not configured
 * on this deployment, Supabase slow or down) the request is treated like a guest's rather than
 * failing a signed-in person who would otherwise be served.
 */
async function verifyBearer(token: string): Promise<Response | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS || !JWT_SHAPE.test(token)) {
    return fail(401, 'Invalid sign-in token.');
  }
  const base = env('VITE_SUPABASE_URL', 'SUPABASE_URL')?.replace(/\/+$/, '');
  const anon = env('VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY');
  if (!base || !anon) return null;
  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: anon },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return fail(401, 'Invalid sign-in token.');
    return null;
  } catch {
    return null;
  }
}

/** Read the body, counting real bytes. Returns null when it exceeds the cap. */
async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function handle(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    // No CORS grants: cross-origin pages get nothing.
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', allow: 'POST, OPTIONS' } });
  }
  if (request.method !== 'POST') return fail(405, 'Use POST.', { allow: 'POST, OPTIONS' });

  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/json')) return fail(415, 'Content-Type must be application/json.');

  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return fail(413, 'Request body is too large.');

  if (rateLimited(clientIp(request), Date.now())) {
    return fail(429, 'Too many simulations. Try again in a minute.', { 'retry-after': '60' });
  }

  const auth = request.headers.get('authorization');
  if (auth !== null) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    const denied = await verifyBearer(m ? m[1] : '');
    if (denied) return denied;
  }

  const text = await readBodyCapped(request, MAX_BODY_BYTES);
  if (text === null) return fail(413, 'Request body is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(400, 'Body is not valid JSON.');
  }

  try {
    const job = parseAnyJob(raw);
    const result = runAnyJob(job, { budgetMs: jobBudgetMs(job.kind) });
    return json(200, { ok: true, ...result });
  } catch (e) {
    if (e instanceof SimJobError) return fail(400, e.message);
    if (e instanceof SimBudgetError) return fail(503, e.message);
    console.error('simulate failed', e instanceof Error ? e.name : 'unknown error');
    return fail(500, 'Simulation failed.');
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch {
      return fail(500, 'Simulation failed.');
    }
  },
};
