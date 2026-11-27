// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLocalConsent } from './consent';
import { initCloud } from './session';
import type { ConsentState } from './types';

const mocks = vi.hoisted(() => {
  const store = {
    enabled: true,
    getConsent: vi.fn(async () => null as ConsentState | null),
    setConsent: vi.fn(async () => true),
  };
  return { store };
});

vi.mock('../auth/client', () => ({
  supabase: { from: () => ({}) },
  currentSession: vi.fn(async () => ({ user: { id: 'user-B' } })),
}));

vi.mock('./store', () => ({
  createCloudStore: vi.fn(() => mocks.store),
}));

vi.mock('./consent', async () => {
  const actual = await vi.importActual<typeof import('./consent')>('./consent');
  return {
    ...actual,
    // Never render the popup in these tests; the pending promise just stays open.
    showConsentDialog: vi.fn(() => new Promise<ConsentState>(() => {})),
  };
});

/** Node 26 exposes a broken global localStorage that shadows jsdom's, so install an in-memory one. */
function installMemoryStorage(): void {
  const m = new Map<string, string>();
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
  for (const target of [globalThis, typeof window !== 'undefined' ? window : undefined]) {
    if (target) Object.defineProperty(target, 'localStorage', { value: storage, configurable: true, writable: true });
  }
}

const OWNER_KEY = 'sfb.consent.owner.v1';
const CONSENT_KEY = 'sfb.consent.v1';

beforeEach(() => {
  installMemoryStorage();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.store.getConsent.mockResolvedValue(null);
  mocks.store.setConsent.mockResolvedValue(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('initCloud consent ownership', () => {
  it('ignores a local answer saved by another account', async () => {
    writeLocalConsent({ research: true, version: 1, decidedAt: 1000 });
    localStorage.setItem(OWNER_KEY, 'user-A');

    const cloud = await initCloud();

    expect(cloud.signedIn).toBe(true);
    expect(cloud.consent()).toBeNull();
    expect(cloud.mayCollect()).toBe(false);
    expect(mocks.store.setConsent).not.toHaveBeenCalled();
  });

  it('re-sends a newer local answer owned by the same account when the remote answer is null', async () => {
    const local: ConsentState = { research: true, version: 1, decidedAt: 1000 };
    writeLocalConsent(local);
    localStorage.setItem(OWNER_KEY, 'user-B');

    const cloud = await initCloud();

    expect(cloud.consent()).toEqual(local);
    expect(cloud.mayCollect()).toBe(true);
    expect(mocks.store.setConsent).toHaveBeenCalledTimes(1);
    expect(mocks.store.setConsent).toHaveBeenCalledWith(local);
  });

  it('does not trust a legacy local answer (no owner recorded) when signed in', async () => {
    writeLocalConsent({ research: true, version: 1, decidedAt: 1000 });
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();

    const cloud = await initCloud();

    expect(cloud.consent()).toBeNull();
    expect(cloud.mayCollect()).toBe(false);
    expect(localStorage.getItem(CONSENT_KEY)).not.toBeNull();
  });
});
