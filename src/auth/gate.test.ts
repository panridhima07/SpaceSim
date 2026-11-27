// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as client from './client';
import { requireAuth } from './gate';

// Mutable holder so each test can switch between "configured" and "not configured".
const state = vi.hoisted(() => ({ supabase: null as unknown }));

vi.mock('./client', () => ({
  get supabase() {
    return state.supabase;
  },
  NATIVE_REDIRECT: 'com.astra.spaceflightbuilder://auth-callback',
  currentSession: vi.fn(async () => null),
  listenForNativeCallback: vi.fn(async () => {}),
  onSignedIn: vi.fn(() => () => {}),
  parseAuthCallback: vi.fn(() => ({})),
  resendConfirmation: vi.fn(async () => {}),
  signInWithEmail: vi.fn(async () => 'ok'),
  signInWithGoogle: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  signUpWithEmail: vi.fn(async () => 'verify'),
}));

// The 3D journey needs WebGL, which jsdom does not have. The gate only uses a few members.
vi.mock('./journey', () => ({
  createJourney: () => ({
    el: document.createElement('div'),
    setProgress() {},
    jumpTo() {},
    focusSite() {},
    onFrame: null,
    dispose() {},
  }),
}));

const GUEST_KEY = 'astra-guest';

beforeAll(() => {
  // jsdom lacks these; the gate uses them for layout and scrolling.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  document.body.replaceChildren();
  window.sessionStorage.clear();
  state.supabase = null;
  vi.mocked(client.currentSession).mockReset().mockResolvedValue(null);
  vi.mocked(client.parseAuthCallback).mockReset().mockReturnValue({});
  vi.mocked(client.onSignedIn).mockReset().mockImplementation(() => () => {});
});

/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const findGuestButton = (): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Continue as guest');

describe('requireAuth without sign-in configured', () => {
  it('shows the guest button and resolves to a guest session when clicked', async () => {
    const settled = vi.fn();
    const promise = requireAuth().then((s) => {
      settled();
      return s;
    });
    await flush();
    expect(settled).not.toHaveBeenCalled();

    const guest = findGuestButton();
    expect(guest).toBeDefined();
    guest!.click();

    const session = await promise;
    expect(session.user.email).toBe('Guest');
    expect(window.sessionStorage.getItem(GUEST_KEY)).toBe('1');
  });

  it('resolves straight to the guest session when the guest flag is already set', async () => {
    window.sessionStorage.setItem(GUEST_KEY, '1');
    const session = await requireAuth();
    expect(session.user.email).toBe('Guest');
    expect(findGuestButton()).toBeUndefined();
  });
});

describe('requireAuth with sign-in configured', () => {
  beforeEach(() => {
    state.supabase = {};
  });

  it('resolves to the remembered guest without showing the gate', async () => {
    window.sessionStorage.setItem(GUEST_KEY, '1');
    const session = await requireAuth();
    expect(session.user.email).toBe('Guest');
    expect(findGuestButton()).toBeUndefined();
    expect(document.querySelector('.auth-card')).toBeNull();
  });

  it('a real session replaces the guest choice and clears the guest flag', async () => {
    window.sessionStorage.setItem(GUEST_KEY, '1');
    const real = { user: { email: 'a@b.c' } };
    vi.mocked(client.currentSession).mockResolvedValue(real as never);
    const session = await requireAuth();
    expect(session).toBe(real);
    expect(window.sessionStorage.getItem(GUEST_KEY)).toBeNull();
    expect(document.querySelector('.auth-chip-email')?.textContent).toBe('a@b.c');
  });
});
