// The login screen. requireAuth() resolves once someone is signed in; until then it covers
// the page with a sign-in / sign-up / confirm-email card. The app itself is loaded afterwards
// (see src/app/boot.ts and src/landing/boot.ts).

import './auth.css';
import type { Session } from '@supabase/supabase-js';
import {
  currentSession,
  listenForNativeCallback,
  onSignedIn,
  parseAuthCallback,
  resendConfirmation,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
  supabase,
} from './client';
import { createJourney } from './journey';
import { PRESETS, type MissionPreset } from './presets';

type View = 'signin' | 'signup' | 'verify';

const RESEND_WAIT_S = 60;

const GOOGLE_ICON =
  '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">' +
  '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.400 13.6 17.700 9.500 24 9.500z"/>' +
  '<path fill="#4285F4" d="M46.1 24.5c0-1.600-.1-3.100-.4-4.500H24v9h12.400c-.5 2.900-2.200 5.300-4.600 7l7.200 5.600c4.200-3.900 7.100-9.600 7.100-17.100z"/>' +
  '<path fill="#FBBC05" d="M10.500 28.700c-.5-1.500-.8-3.100-.8-4.700s.3-3.200.8-4.700l-7.900-6.100C1 16.500 0 20.100 0 24s1 7.500 2.600 10.800l7.900-6.100z"/>' +
  '<path fill="#34A853" d="M24 48c6.300 0 11.700-2.100 15.600-5.700l-7.200-5.600c-2.100 1.400-4.900 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z"/>' +
  '</svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/invalid login credentials/i.test(raw)) return 'Wrong email or password.';
  if (/expired|invalid.*link|code verifier/i.test(raw)) return 'That link has expired or was opened in another browser. Sign in, or send a new link.';
  if (/rate limit|security purposes/i.test(raw)) return 'Too many attempts. Wait a minute and try again.';
  if (/failed to fetch|network/i.test(raw)) return 'No connection. Check your internet and try again.';
  return raw;
}

/** The landing copy shown beside the sign-up card. */
function buildPitch(): HTMLElement {
  const pitch = el('section', 'auth-pitch');
  const title = el('h1', 'auth-title');
  title.append('ASTRA ', el('span', '', 'SPACEFLIGHT'));
  pitch.append(
    el('p', 'auth-kicker', 'ASTRA 2026 · VIT BHOPAL'),
    title,
    el('p', 'auth-lede', 'Design a rocket, fly it, and find its flaws before you build it.'),
  );
  return pitch;
}

// ---------- Scroll journey shell ----------

const SESSION_PRESET_KEY = 'astra-preset';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Static inline SVG (no dynamic text, so innerHTML is safe here). */
function svgIcon(inner: string, cls: string, viewBox = '0 0 32 32', size = 20): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML =
    `<svg class="${cls}" viewBox="${viewBox}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${inner}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

const BRAND_MARK =
  '<path d="M16 3l6 17-6-3.6L10 20z" fill="currentColor"/><path d="M9 24h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

const GLYPHS: Record<string, string> = {
  // An arc that ends at a small circle: the Moon.
  'chandrayaan-3':
    '<path d="M3 24C8 8 18 5 24 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="26" cy="11" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  // A loop that goes up and comes back down.
  'starship-catch':
    '<path d="M10 28V12a6 6 0 1 1 12 0v16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M19 24l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  // A ring around a dot.
  starlink:
    '<circle cx="16" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};

interface CaptionDef {
  a: number;
  b: number;
  kicker: string;
  heading: string;
  line: string;
}

const CAPTIONS: CaptionDef[] = [
  { a: -1, b: 0.05, kicker: 'ASTRA 2026 · VIT BHOPAL', heading: 'ASTRA SPACEFLIGHT', line: 'Scroll to fall from the galaxy to the launch pad.' },
  { a: 0.07, b: 0.24, kicker: '01 · The Milky Way', heading: '100,000 light-years across', line: 'Somewhere in one of its spiral arms is a small yellow star.' },
  { a: 0.28, b: 0.44, kicker: '02 · The neighbourhood', heading: 'The nearest stars', line: 'Alpha Centauri is 4.4 light-years away. Sirius, the brightest star in our sky, is 8.6.' },
  { a: 0.5, b: 0.66, kicker: '03 · The solar system', heading: 'One star, eight planets', line: 'The third one out has oceans, and people who build rockets.' },
  { a: 0.7, b: 0.82, kicker: '04 · Earth', heading: 'Home', line: 'More than 10,000 working satellites circle it. Three flights are waiting below.' },
];

const RAIL: Array<{ label: string; p: number }> = [
  { label: 'Milky Way', p: 0 },
  { label: 'Nearby stars', p: 0.15 },
  { label: 'Solar system', p: 0.36 },
  { label: 'Earth', p: 0.6 },
  { label: 'Sign in', p: 1 },
];
// Eased progress at which each rail dot becomes the current one (midpoints between targets).
const RAIL_EDGES = [0.075, 0.255, 0.48, 0.8];

function buildMissionCard(preset: MissionPreset): HTMLButtonElement {
  const btn = el('button', 'auth-mission');
  btn.type = 'button';
  btn.dataset.id = preset.id;
  const head = el('span', 'auth-mission-head');
  head.append(el('span', 'auth-mission-kicker', `${preset.agency} · ${preset.vehicle}`), svgIcon(GLYPHS[preset.id] ?? '', 'auth-mission-glyph', '0 0 32 32', 26));
  const foot = el('span', 'auth-mission-foot');
  foot.append(
    el('span', 'auth-mission-date', preset.date),
    el('span', `auth-pill auth-pill-${preset.status}`, preset.status === 'flyable' ? 'Flyable' : 'Brief'),
  );
  btn.append(head, el('span', 'auth-mission-name', preset.name), el('span', 'auth-mission-line', preset.line), foot);
  return btn;
}

function buildBrief(preset: MissionPreset): {
  brief: HTMLElement;
  back: HTMLButtonElement;
  go: HTMLButtonElement;
  flyNow: HTMLButtonElement | null;
} {
  const brief = el('div', 'auth-brief');
  brief.setAttribute('role', 'region');
  brief.setAttribute('aria-label', `${preset.name} mission brief`);
  const back = el('button', 'auth-link auth-back', '← All missions');
  back.type = 'button';

  const facts = el('dl', 'auth-facts');
  for (const f of preset.facts) facts.append(el('dt', '', f.label), el('dd', '', f.value));

  const steps = el('ol', 'auth-timeline');
  for (const s of preset.timeline) {
    const li = el('li');
    li.append(el('span', 'auth-t', s.t), el('span', '', s.label));
    steps.append(li);
  }

  let flyNow: HTMLButtonElement | null = null;
  if (preset.status === 'flyable') {
    flyNow = el('button', 'auth-btn auth-primary', `Fly ${preset.name} now`);
    flyNow.type = 'button';
  }

  const go = el(
    'button',
    preset.status === 'flyable' ? 'auth-link' : 'auth-btn auth-primary',
    preset.status === 'flyable' ? 'Or sign in to save your flights' : 'Sign in to build your own',
  );
  go.type = 'button';

  brief.append(
    back,
    el('p', 'auth-mission-kicker', `${preset.agency} · ${preset.vehicle}`),
    el('h3', 'auth-brief-name', preset.name),
    el('p', 'auth-brief-line', preset.line),
    facts,
    steps,
  );
  if (preset.timelineNote) brief.append(el('p', 'auth-hint', preset.timelineNote));
  brief.append(el('p', 'auth-brief-status', preset.statusText));
  if (flyNow) brief.append(flyNow);
  brief.append(go);
  return { brief, back, go, flyNow };
}

/**
 * The shared landing page: 3D journey behind, captions, rail, missions and the given card.
 * The caller fills `card`. Starts at the top unless startAtEnd is set.
 */
function mountShell(
  card: HTMLElement,
  startAtEnd: boolean,
  onBypass?: (presetId?: string) => void,
): { root: HTMLElement; dispose: () => void } {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const narrow = window.matchMedia('(max-width: 899px)');
  const root = el('div', 'auth-root');
  const journey = createJourney(PRESETS.map((p) => p.site));
  const track = el('div', 'auth-track');
  track.setAttribute('aria-hidden', 'true');

  // --- HUD ---
  const hud = el('div', 'auth-hud');
  const brand = el('div', 'auth-brand');
  brand.setAttribute('aria-hidden', 'true');
  brand.append(svgIcon(BRAND_MARK, 'auth-brand-mark'), el('span', '', 'ASTRA'));

  const progressToTop = (p: number) => {
    root.scrollTo({ top: p * track.offsetHeight, behavior: reduced ? 'auto' : 'smooth' });
  };

  const skip = el('button', 'auth-skip', 'Skip to sign in');
  skip.type = 'button';
  skip.addEventListener('click', () => progressToTop(1));

  const rail = el('nav', 'auth-rail');
  rail.setAttribute('aria-label', 'Page sections');
  const dots = RAIL.map((r) => {
    const b = el('button', 'auth-dot');
    b.type = 'button';
    b.setAttribute('aria-label', r.label);
    b.title = r.label;
    b.addEventListener('click', () => progressToTop(r.p));
    rail.append(b);
    return b;
  });

  const caps = CAPTIONS.map((c, i) => {
    const node = el('div', i === 0 ? 'auth-cap auth-cap-hero' : 'auth-cap');
    node.setAttribute('aria-hidden', 'true');
    const heading = el('div', i === 0 ? 'auth-title auth-cap-title' : 'auth-cap-heading');
    if (i === 0) heading.append('ASTRA ', el('span', '', 'SPACEFLIGHT'));
    else heading.textContent = c.heading;
    node.append(el('p', 'auth-kicker auth-cap-kicker', c.kicker), heading, el('p', 'auth-cap-line', c.line));
    return node;
  });

  const hint = el('div', 'auth-scrollhint');
  hint.setAttribute('aria-hidden', 'true');
  hint.append(el('span', '', 'Scroll'), el('span', 'auth-scrollhint-line'));

  hud.append(brand, skip, rail, ...caps, hint);

  // --- Final page ---
  const page = el('main', 'auth-page');

  const missions = el('section', 'auth-missions');
  missions.setAttribute('aria-label', 'Example flights');
  const slot = el('div', 'auth-mission-slot');
  const list = el('div', 'auth-mission-list');
  let selectedId: string | null = null;
  let opener: HTMLButtonElement | null = null;

  const closeBrief = () => {
    selectedId = null;
    slot.replaceChildren(list);
    journey.focusSite(null);
    opener?.focus();
    opener = null;
  };

  const openBrief = (preset: MissionPreset, from: HTMLButtonElement) => {
    selectedId = preset.id;
    opener = from;
    const { brief, back, go, flyNow } = buildBrief(preset);
    back.addEventListener('click', closeBrief);
    brief.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeBrief();
      }
    });
    if (flyNow) {
      flyNow.addEventListener('click', () => {
        try {
          window.sessionStorage.setItem(SESSION_PRESET_KEY, preset.id);
        } catch {
          // Ignore storage restrictions.
        }
        onBypass?.(preset.id);
      });
    }
    go.addEventListener('click', () => {
      try {
        window.sessionStorage.setItem(SESSION_PRESET_KEY, preset.id);
      } catch {
        // Storage can be blocked; the choice just is not remembered.
      }
      const first = card.querySelector<HTMLInputElement>('input');
      if (narrow.matches) card.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      first?.focus({ preventScroll: narrow.matches });
    });
    slot.replaceChildren(brief);
    journey.focusSite(preset.id);
    back.focus();
  };

  for (const preset of PRESETS) {
    const btn = buildMissionCard(preset);
    const hover = () => journey.focusSite(preset.id);
    const leave = () => journey.focusSite(selectedId);
    btn.addEventListener('mouseenter', hover);
    btn.addEventListener('focus', hover);
    btn.addEventListener('mouseleave', leave);
    btn.addEventListener('blur', leave);
    btn.addEventListener('click', () => openBrief(preset, btn));
    list.append(btn);
  }
  slot.append(list);
  missions.append(el('p', 'auth-kicker auth-missions-kicker', 'Three real flights · open without an account'), slot);

  page.append(buildPitch(), missions, card);
  root.append(journey.el, hud, track, page);

  // --- Progress ---
  const progressOf = () => clamp01(root.scrollTop / Math.max(1, track.offsetHeight));
  const onScroll = () => journey.setProgress(progressOf());
  root.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  let railIndex = -1;
  const update = (p: number) => {
    caps.forEach((node, i) => {
      const { a, b } = CAPTIONS[i]!;
      const o = smoothstep(a, a + 0.03, p) * (1 - smoothstep(b - 0.03, b, p));
      node.style.opacity = o.toFixed(3);
      node.style.transform = `translateY(${((1 - smoothstep(a, a + 0.03, p)) * 10).toFixed(1)}px)`;
    });
    let idx = RAIL_EDGES.findIndex((edge) => p < edge);
    if (idx < 0) idx = RAIL.length - 1;
    if (idx !== railIndex) {
      railIndex = idx;
      dots.forEach((d, i) => {
        d.classList.toggle('is-on', i === idx);
        if (i === idx) d.setAttribute('aria-current', 'true');
        else d.removeAttribute('aria-current');
      });
    }
    skip.classList.toggle('is-off', p > 0.9);
    hint.classList.toggle('is-on', p < 0.03);
  };
  journey.onFrame = update;

  document.body.append(root);
  if (startAtEnd) {
    root.scrollTop = root.scrollHeight;
    journey.jumpTo(1);
    update(1);
  } else {
    journey.jumpTo(0);
    update(0);
  }

  return {
    root,
    dispose: () => {
      journey.onFrame = null;
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      journey.dispose();
    },
  };
}

function mountGate(
  initialError: string | undefined,
  onBypass?: (presetId?: string) => void,
): { root: HTMLElement; showError: (m: string) => void; dispose: () => void } {
  const card = el('div', 'auth-card');

  // First-time visitors land on sign-up; a returning visitor is one click from sign-in.
  let view: View = 'signup';
  let email = '';
  // Kept only in memory, so the confirm screen can sign in once the link has been opened.
  let pendingPassword = '';
  let busy = false;
  let resendTimer = 0;

  const status = el('p', 'auth-status');
  status.setAttribute('role', 'status');
  const setStatus = (text: string, kind: 'error' | 'info' = 'error') => {
    status.textContent = text;
    status.dataset.kind = kind;
  };

  const run = async (button: HTMLButtonElement, work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    setStatus('');
    try {
      await work();
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      busy = false;
      button.disabled = false;
    }
  };

  const field = (label: string, type: string, autocomplete: string, value = ''): HTMLInputElement => {
    const wrap = el('label', 'auth-field');
    const input = el('input');
    input.type = type;
    input.required = true;
    input.autocomplete = autocomplete as AutoFill;
    input.value = value;
    wrap.append(el('span', '', label), input);
    card.append(wrap);
    return input;
  };

  const startResendCountdown = (button: HTMLButtonElement) => {
    window.clearInterval(resendTimer);
    let left = RESEND_WAIT_S;
    const tick = () => {
      button.disabled = left > 0;
      button.textContent = left > 0 ? `Send a new link (${left}s)` : 'Send a new link';
      if (left-- <= 0) window.clearInterval(resendTimer);
    };
    tick();
    resendTimer = window.setInterval(tick, 1000);
  };

  const render = () => {
    window.clearInterval(resendTimer);
    card.replaceChildren();

    if (view === 'verify') {
      card.append(el('h2', '', 'Check your email'));
      const hint = el('p', 'auth-hint');
      hint.append('We sent a confirmation link to ', el('b', '', email), '. Open it on this device to finish signing up.');
      card.append(hint);
      // Opening the link in this browser signs in on its own. This button covers a link
      // opened somewhere else (another browser, a phone).
      const submit = el('button', 'auth-btn auth-primary', 'I have confirmed, continue');
      submit.type = 'button';
      submit.addEventListener('click', () => {
        void run(submit, async () => {
          if (!pendingPassword) {
            view = 'signin';
            render();
            return;
          }
          if ((await signInWithEmail(email, pendingPassword)) === 'unverified') {
            setStatus('Not confirmed yet. Open the link in the email first.');
          }
        });
      });
      const resend = el('button', 'auth-link');
      resend.type = 'button';
      resend.addEventListener('click', () => {
        void run(resend, async () => {
          await resendConfirmation(email);
          setStatus('New link sent.', 'info');
          startResendCountdown(resend);
        });
      });
      const back = el('button', 'auth-link', 'Use a different email');
      back.type = 'button';
      back.addEventListener('click', () => {
        view = 'signup';
        setStatus('');
        render();
      });
      card.append(submit, status, resend, back);
      startResendCountdown(resend);
      return;
    }

    const signup = view === 'signup';
    card.append(el('h2', '', signup ? 'Sign up to start building' : 'Sign in'));

    const google = el('button', 'auth-btn auth-google');
    google.type = 'button';
    google.innerHTML = GOOGLE_ICON;
    google.append(el('span', '', 'Continue with Google'));
    google.addEventListener('click', () => void run(google, signInWithGoogle));
    card.append(google, el('div', 'auth-or', 'or'));

    const form = el('form');
    card.append(form);
    const emailInput = field('Email', 'email', 'email', email);
    const password = field('Password', 'password', signup ? 'new-password' : 'current-password');
    if (signup) password.minLength = 8;
    const submit = el('button', 'auth-btn auth-primary', signup ? 'Sign up and build' : 'Sign in');
    submit.type = 'submit';
    form.append(emailInput.parentElement!, password.parentElement!);
    if (signup) form.append(el('p', 'auth-hint', 'At least 8 characters. We will email you a link to confirm the address.'));
    form.append(submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      email = emailInput.value.trim();
      pendingPassword = password.value;
      void run(submit, async () => {
        if (signup) {
          const result = await signUpWithEmail(email, password.value);
          if (result === 'exists') {
            view = 'signin';
            render();
            setStatus('That email already has an account. Sign in instead.', 'info');
          } else if (result === 'verify') {
            view = 'verify';
            render();
          }
        } else if ((await signInWithEmail(email, password.value)) === 'unverified') {
          await resendConfirmation(email).catch(() => {});
          view = 'verify';
          render();
          setStatus('Confirm your email first. We sent you a new link.', 'info');
        }
      });
    });

    const swap = el('button', 'auth-link', signup ? 'Already have an account? Sign in' : 'New here? Create an account');
    swap.type = 'button';
    swap.addEventListener('click', () => {
      email = emailInput.value.trim();
      view = signup ? 'signin' : 'signup';
      setStatus('');
      render();
    });
    const guest = el('button', 'auth-link', 'Continue as guest');
    guest.type = 'button';
    guest.addEventListener('click', () => onBypass?.());
    card.append(status, swap, guest);
  };

  render();
  if (initialError) setStatus(initialError);
  // Jump straight to the form when there is an error to read.
  const shell = mountShell(card, Boolean(initialError) || (view as View) === 'verify' || prefersReducedMotion(), onBypass);
  return { root: shell.root, showError: (m) => setStatus(m), dispose: shell.dispose };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function mountNotConfigured(): void {
  const card = el('div', 'auth-card');
  card.append(
    el('h2', '', 'Sign-in is not set up'),
    el('p', 'auth-hint', 'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env (see .env.example), then restart.'),
  );
  mountShell(card, prefersReducedMotion());
}

/** A small account button, bottom-left, with the signed-in email and a sign-out action. */
function mountAccountChip(session: Session): void {
  const chip = el('div', 'auth-chip');
  const toggle = el('button', 'auth-chip-toggle');
  toggle.type = 'button';
  const address = session.user.email ?? 'Account';
  toggle.textContent = address.charAt(0).toUpperCase();
  toggle.title = address;
  toggle.setAttribute('aria-label', `Account: ${address}`);
  toggle.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'auth-chip-menu');
  menu.hidden = true;
  const out = el('button', 'auth-btn', 'Sign out');
  out.type = 'button';
  out.addEventListener('click', async () => {
    out.disabled = true;
    await signOut().catch(() => {});
    window.location.reload();
  });
  menu.append(el('span', 'auth-chip-email', address), out);
  toggle.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!chip.contains(e.target as Node)) {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  chip.append(menu, toggle);
  document.body.append(chip);
}

/**
 * Resolves with the session once someone is signed in. Never resolves if sign-in is not set up.
 * When the landing page had to be shown, freshKey is set in sessionStorage so the page can
 * tell a new sign-in from a returning visit.
 */
export async function requireAuth(freshKey?: string): Promise<Session> {
  if (!supabase) {
    mountNotConfigured();
    return new Promise<Session>(() => {});
  }
  // An error or PKCE code handed back by Google or an email link.
  const { code, error: returnError } = parseAuthCallback(window.location.href);
  if (returnError) window.history.replaceState(null, '', window.location.pathname);

  let session = await currentSession().catch(() => null);
  if (!session && code) {
    const exchanged = await supabase.auth.exchangeCodeForSession(code).catch(() => null);
    if (exchanged?.data?.session) {
      session = exchanged.data.session;
    }
  }
  if (code) window.history.replaceState(null, '', window.location.pathname);

  if (!session) {
    // Kept in sessionStorage so it survives the round trip to Google and back.
    if (freshKey) {
      try {
        window.sessionStorage.setItem(freshKey, '1');
      } catch {
        // Private windows can refuse storage; the app then opens on its title screen.
      }
    }
    let resolveGate: ((s: Session) => void) | null = null;
    const gate = mountGate(returnError, () => {
      resolveGate?.({ user: { email: 'Guest' } } as unknown as Session);
    });
    void listenForNativeCallback(gate.showError);
    session = await new Promise<Session>((resolve) => {
      const stop = onSignedIn((s) => {
        stop();
        resolve(s);
      });
      resolveGate = (guestSession) => {
        stop();
        resolve(guestSession);
      };
    });
    gate.dispose();
    gate.root.remove();
  }
  mountAccountChip(session);
  return session;
}
