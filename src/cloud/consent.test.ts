// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { CONSENT_KEY, needsConsent, readLocalConsent, showConsentDialog, writeLocalConsent } from './consent';
import { CONSENT_VERSION, type ConsentState } from './types';

const sw = () => document.querySelector<HTMLInputElement>('.sfb-consent input[role="switch"]')!;
const btn = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.sfb-consent button')).find((b) => b.textContent === label)!;

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

let store = memoryStore();

beforeEach(() => {
  document.body.innerHTML = '';
  store = memoryStore();
});

describe('stored consent', () => {
  it('round-trips', () => {
    const c: ConsentState = { research: true, version: CONSENT_VERSION, decidedAt: 123 };
    writeLocalConsent(c, store);
    expect(readLocalConsent(store)).toEqual(c);
    expect(needsConsent(readLocalConsent(store))).toBe(false);
  });

  it('treats an outdated version as not asked', () => {
    const old: ConsentState = { research: true, version: CONSENT_VERSION - 1, decidedAt: 1 };
    store.setItem(CONSENT_KEY, JSON.stringify(old));
    expect(readLocalConsent(store)).toBeNull();
    expect(needsConsent(old)).toBe(true);
    expect(needsConsent(null)).toBe(true);
  });

  it('does not throw on corrupt JSON or wrong shapes', () => {
    store.setItem(CONSENT_KEY, '{not json');
    expect(readLocalConsent(store)).toBeNull();
    store.setItem(CONSENT_KEY, '{"research":"yes"}');
    expect(readLocalConsent(store)).toBeNull();
    store.setItem(CONSENT_KEY, 'null');
    expect(readLocalConsent(store)).toBeNull();
  });
});

describe('consent dialog', () => {
  it('renders as an accessible modal with the switch off', () => {
    void showConsentDialog();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)!.textContent).toBe('Your data, your choice');
    expect(sw().checked).toBe(false);
    expect(sw().disabled).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Save my choice with the switch on resolves research:true', async () => {
    const p = showConsentDialog();
    sw().click();
    const before = Date.now();
    btn('Save my choice').click();
    const c = await p;
    expect(c.research).toBe(true);
    expect(c.version).toBe(CONSENT_VERSION);
    expect(c.decidedAt).toBeGreaterThanOrEqual(before);
    expect(Date.now() - c.decidedAt).toBeLessThan(5000);
  });

  it('Save my choice with the switch off resolves research:false', async () => {
    const p = showConsentDialog();
    btn('Save my choice').click();
    expect((await p).research).toBe(false);
  });

  it('No thanks resolves research:false even if the switch is on', async () => {
    const p = showConsentDialog();
    sw().click();
    btn('No thanks').click();
    expect((await p).research).toBe(false);
  });

  it('Escape declines', async () => {
    const p = showConsentDialog({ current: { research: true, version: CONSENT_VERSION, decidedAt: 1 } });
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect((await p).research).toBe(false);
  });

  it('backdrop click does not dismiss', () => {
    void showConsentDialog();
    document.querySelector<HTMLElement>('.sfb-consent')!.click();
    expect(document.querySelector('.sfb-consent')).not.toBeNull();
  });

  it('removes itself and restores focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const p = showConsentDialog();
    expect(document.activeElement).not.toBe(opener);
    btn('No thanks').click();
    await p;
    expect(document.querySelector('.sfb-consent')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('traps Tab focus inside the dialog', () => {
    void showConsentDialog();
    const save = btn('Save my choice');
    save.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    save.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sw());
  });

  it('signedIn:false disables the switch and shows the guest notes', async () => {
    const p = showConsentDialog({ signedIn: false, current: { research: true, version: CONSENT_VERSION, decidedAt: 1 } });
    expect(sw().disabled).toBe(true);
    expect(sw().checked).toBe(false);
    expect(document.body.textContent).toContain('Sign in to take part');
    expect(document.body.textContent).toContain('stays in this browser');
    btn('Save my choice').click();
    expect((await p).research).toBe(false);
  });

  it('hides the guest notes when signed in', () => {
    void showConsentDialog({ signedIn: true });
    expect(document.body.textContent).not.toContain('Sign in to take part');
  });

  it('current pre-sets the switch', () => {
    void showConsentDialog({ current: { research: true, version: CONSENT_VERSION, decidedAt: 1 } });
    expect(sw().checked).toBe(true);
  });
});
