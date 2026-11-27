// The private usage dashboard at /admin.html.
//
// Access is decided by the database, not by this page: public.admin_stats() raises unless the
// signed-in account is listed in public.admins (supabase/migrations/0003_usage_and_admin.sql).
// This page only signs someone in and shows what the function returns, or why it refused.
// It has its own small sign-in form: the app's gate (src/auth/gate.ts) offers guest mode and
// sign-up, which have no place here.
import './admin.css';
import './signin.css';
import type { Session } from '@supabase/supabase-js';
import { currentSession, parseAuthCallback, signInWithEmail, signInWithGoogle, signOut, supabase } from '../auth/client';
import { classifyStatsError, FAILURE_TEXT, type StatsFailure } from './access';
import { mountDashboard } from './dashboard';
import { parseReleases, parseStats } from './shape';
import type { AdminStats, ReleaseDownloads, StatsWindow } from './types';

const RELEASES_URL = 'https://api.github.com/repos/panridhima07/SpaceSim/releases?per_page=30';

class StatsError extends Error {
  constructor(readonly failure: StatsFailure) {
    super(FAILURE_TEXT[failure]);
  }
}

async function fetchStats(days: StatsWindow): Promise<AdminStats> {
  if (!supabase) throw new StatsError('other');
  const { data, error } = await supabase.rpc('admin_stats', { p_days: days });
  if (error) throw new StatsError(classifyStatsError(error));
  return parseStats(data);
}

// GitHub allows only 60 unauthenticated API requests per hour per IP, so the release list is cached in
// sessionStorage for 10 minutes, and a stale copy is used if GitHub fails or rate-limits the request.
const RELEASES_CACHE_KEY = 'astra-admin-releases';
const RELEASES_TTL_MS = 10 * 60_000;

function readReleasesCache(): { at: number; data: unknown } | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(RELEASES_CACHE_KEY) ?? 'null') as { at?: unknown; data?: unknown } | null;
    return parsed && typeof parsed.at === 'number' && parsed.data !== undefined ? { at: parsed.at, data: parsed.data } : null;
  } catch {
    return null;
  }
}

async function fetchReleases(): Promise<ReleaseDownloads[]> {
  const cached = readReleasesCache();
  if (cached && Date.now() - cached.at < RELEASES_TTL_MS) return parseReleases(cached.data);
  let res: Response;
  try {
    res = await fetch(RELEASES_URL, { headers: { accept: 'application/vnd.github+json' } });
  } catch (err) {
    if (cached) return parseReleases(cached.data);
    throw err;
  }
  if (!res.ok) {
    if (cached) return parseReleases(cached.data);
    throw new Error('Could not reach GitHub.');
  }
  const data: unknown = await res.json();
  try {
    sessionStorage.setItem(RELEASES_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota or privacy-mode errors: the cache is optional, so ignore them.
  }
  return parseReleases(data);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function showMessage(root: HTMLElement, text: string, kind: 'info' | 'error', action?: { label: string; run: () => void }): void {
  const box = el('div', 'admin-signin');
  const p = el('p', kind === 'error' ? 'admin-message admin-error' : 'admin-message', text);
  p.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  box.append(el('h1', 'admin-signin-title', 'ASTRA usage'), p);
  if (action) {
    const b = el('button', 'admin-btn', action.label);
    b.type = 'button';
    b.addEventListener('click', action.run);
    box.append(b);
  }
  root.replaceChildren(box);
}

function showSignIn(root: HTMLElement, initialError?: string): void {
  const box = el('div', 'admin-signin');
  const status = el('p', 'admin-message admin-error');
  status.setAttribute('role', 'alert');
  status.textContent = initialError ?? '';

  let busy = false;
  const run = async (button: HTMLButtonElement, work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = '';
    try {
      await work();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      status.textContent = /invalid login credentials/i.test(raw)
        ? 'Wrong email or password.'
        : /failed to fetch|network/i.test(raw)
          ? 'No connection. Check your internet and try again.'
          : raw;
    } finally {
      busy = false;
      button.disabled = false;
    }
  };

  const google = el('button', 'admin-btn admin-signin-wide', 'Continue with Google');
  google.type = 'button';
  google.addEventListener('click', () => void run(google, signInWithGoogle));

  const form = el('form', 'admin-signin-form');
  const field = (label: string, type: string, autocomplete: AutoFill): HTMLInputElement => {
    const wrap = el('label', 'admin-field');
    const input = el('input');
    input.type = type;
    input.required = true;
    input.autocomplete = autocomplete;
    wrap.append(el('span', '', label), input);
    form.append(wrap);
    return input;
  };
  const email = field('Email', 'email', 'email');
  const password = field('Password', 'password', 'current-password');
  const submit = el('button', 'admin-btn admin-signin-wide', 'Sign in');
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run(submit, async () => {
      if ((await signInWithEmail(email.value.trim(), password.value)) === 'unverified') {
        status.textContent = 'Confirm your email address first (use the link we sent when you signed up).';
        return;
      }
      await start(root);
    });
  });

  box.append(
    el('h1', 'admin-signin-title', 'ASTRA usage'),
    el('p', 'admin-message', 'Sign in with an admin account.'),
    google,
    el('div', 'admin-signin-or', 'or'),
    form,
    status,
  );
  root.replaceChildren(box);
  email.focus();
}

async function showFor(root: HTMLElement, session: Session): Promise<void> {
  showMessage(root, 'Loading…', 'info');
  const leave = async (): Promise<void> => {
    await signOut().catch(() => {});
    showSignIn(root);
  };
  // The first request doubles as the access check.
  let first: AdminStats;
  try {
    first = await fetchStats(30);
  } catch (err) {
    const failure = err instanceof StatsError ? err.failure : 'other';
    if (failure === 'signed-out') {
      await signOut().catch(() => {});
      showSignIn(root, FAILURE_TEXT['signed-out']);
      return;
    }
    const text = err instanceof Error ? err.message : FAILURE_TEXT.other;
    const who = session.user.email ? ` Signed in as ${session.user.email}.` : '';
    showMessage(
      root,
      failure === 'not-admin' ? text + who : text,
      'error',
      failure === 'other' ? { label: 'Try again', run: () => void showFor(root, session) } : { label: 'Sign out', run: () => void leave() },
    );
    return;
  }
  let reuse: AdminStats | null = first;
  mountDashboard(root, {
    email: session.user.email ?? 'Admin',
    loadStats: (days) => {
      if (days === 30 && reuse) {
        const cached = reuse;
        reuse = null;
        return Promise.resolve(cached);
      }
      return fetchStats(days);
    },
    loadReleases: fetchReleases,
    onSignOut: () => void leave(),
  });
}

async function start(root: HTMLElement): Promise<void> {
  if (!supabase) {
    showMessage(root, 'Sign-in is not set up on this deployment (the site was built without its Supabase settings).', 'error');
    return;
  }
  showMessage(root, 'Loading…', 'info');
  // An error or a sign-in code handed back by Google.
  const { code, error: returnError } = parseAuthCallback(window.location.href);
  let session = await currentSession().catch(() => null);
  let exchangeFailed = false;
  if (!session && code) {
    const exchanged = await supabase.auth.exchangeCodeForSession(code).catch(() => null);
    session = exchanged?.data?.session ?? null;
    exchangeFailed = !session;
  }
  if (code || returnError) window.history.replaceState(null, '', window.location.pathname);

  if (!session) {
    const expired = exchangeFailed ? 'That sign-in link expired or was already used. Try again.' : undefined;
    showSignIn(root, returnError || expired);
    return;
  }
  await showFor(root, session);
}

const mount = document.getElementById('admin');
if (mount) void start(mount);
