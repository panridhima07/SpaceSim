import { describe, expect, it } from 'vitest';
import { installId, shouldSend, usageAllowed, type UsageEnv } from './usage';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

const broken = {
  getItem: (): string | null => {
    throw new Error('storage disabled');
  },
  setItem: (): void => {
    throw new Error('storage disabled');
  },
};

const web = (over: Partial<UsageEnv> = {}): UsageEnv => ({
  doNotTrack: null,
  globalPrivacyControl: undefined,
  hostname: 'astra-spaceflight.vercel.app',
  native: false,
  nativeDebug: false,
  ...over,
});

const app = (over: Partial<UsageEnv> = {}): UsageEnv => ({
  doNotTrack: null,
  globalPrivacyControl: undefined,
  hostname: 'localhost',
  native: true,
  nativeDebug: false,
  ...over,
});

describe('usageAllowed', () => {
  it('is false when Do Not Track is "1"', () => {
    expect(usageAllowed(web({ doNotTrack: '1' }))).toBe(false);
  });

  it('is false when Do Not Track is "yes"', () => {
    expect(usageAllowed(web({ doNotTrack: 'yes' }))).toBe(false);
  });

  it('is false when Global Privacy Control is set', () => {
    expect(usageAllowed(web({ globalPrivacyControl: true }))).toBe(false);
  });

  it('is true on the website when Do Not Track is null, "0" or undefined', () => {
    expect(usageAllowed(web({ doNotTrack: null }))).toBe(true);
    expect(usageAllowed(web({ doNotTrack: '0' }))).toBe(true);
    expect(usageAllowed(web({ doNotTrack: undefined }))).toBe(true);
  });

  it('is false on the website when served from localhost, 127.0.0.1 or [::1]', () => {
    expect(usageAllowed(web({ hostname: 'localhost' }))).toBe(false);
    expect(usageAllowed(web({ hostname: '127.0.0.1' }))).toBe(false);
    expect(usageAllowed(web({ hostname: '[::1]' }))).toBe(false);
  });

  it('is true inside the release app', () => {
    expect(usageAllowed(app())).toBe(true);
  });

  it('is false inside a debug app build', () => {
    expect(usageAllowed(app({ nativeDebug: true }))).toBe(false);
  });

  it('still honours Do Not Track inside the app', () => {
    expect(usageAllowed(app({ doNotTrack: '1' }))).toBe(false);
  });
});

describe('installId', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('creates a UUID and stores it', () => {
    const store = mem();
    const id = installId(store);
    expect(id).toMatch(UUID);
    expect(store.getItem('astra-install-id')).toBe(id);
  });

  it('returns the same id on the second call', () => {
    const store = mem();
    const first = installId(store);
    const second = installId(store);
    expect(second).toBe(first);
  });

  it('replaces a stored value that is not a UUID', () => {
    const store = mem();
    store.setItem('astra-install-id', 'hello');
    const id = installId(store);
    expect(id).toMatch(UUID);
    expect(id).not.toBe('hello');
    expect(store.getItem('astra-install-id')).toBe(id);
  });

  it('returns null when the store throws', () => {
    expect(installId(broken)).toBeNull();
  });
});

describe('shouldSend', () => {
  it('counts "open" once per session: true the first time, false the second', () => {
    const session = mem();
    expect(shouldSend('open', session)).toBe(true);
    expect(shouldSend('open', session)).toBe(false);
  });

  it('always sends "flight", "mission" and "import"', () => {
    const session = mem();
    for (const event of ['flight', 'mission', 'import'] as const) {
      expect(shouldSend(event, session)).toBe(true);
      expect(shouldSend(event, session)).toBe(true);
    }
  });

  it('sends "open" when the session store throws', () => {
    expect(shouldSend('open', broken)).toBe(true);
  });
});
