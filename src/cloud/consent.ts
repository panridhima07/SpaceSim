// The data-collection consent popup, and the stored decision behind it.
// The stylesheet (./consent.css) is imported by whoever wires this in, not here.

import { CONSENT_VERSION, type ConsentState } from './types';

export const CONSENT_KEY = 'sfb.consent.v1';

function defaultStore(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // Storage can be blocked entirely.
  }
}

/** The stored decision, or null when never asked or asked under an older CONSENT_VERSION. */
export function readLocalConsent(store: Pick<Storage, 'getItem'> | undefined = defaultStore()): ConsentState | null {
  try {
    const raw = store?.getItem(CONSENT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ConsentState> | null;
    if (
      !v ||
      typeof v !== 'object' ||
      typeof v.research !== 'boolean' ||
      typeof v.version !== 'number' ||
      typeof v.decidedAt !== 'number'
    ) {
      return null;
    }
    if (v.version !== CONSENT_VERSION) return null;
    return { research: v.research, version: v.version, decidedAt: v.decidedAt };
  } catch {
    return null;
  }
}

export function writeLocalConsent(c: ConsentState, store: Pick<Storage, 'setItem'> | undefined = defaultStore()): void {
  try {
    store?.setItem(CONSENT_KEY, JSON.stringify(c));
  } catch {
    // Storage full or blocked; the person is simply asked again next time.
  }
}

/** True when the person must be asked (no decision, or an outdated version). */
export function needsConsent(c: ConsentState | null): boolean {
  return !c || c.version !== CONSENT_VERSION;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function list(items: string[]): HTMLUListElement {
  const ul = el('ul', 'sfb-consent-list');
  for (const t of items) ul.append(el('li', '', t));
  return ul;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
let idCounter = 0;

/**
 * Shows the popup and resolves with the decision. `current` pre-sets the switch when the
 * popup is reopened from settings. Resolves with research:false if dismissed.
 */
export function showConsentDialog(
  opts: { current?: ConsentState | null; signedIn?: boolean; parent?: HTMLElement } = {},
): Promise<ConsentState> {
  const signedIn = opts.signedIn !== false;
  const parent = opts.parent ?? document.body;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const uid = `sfb-consent-${++idCounter}`;

  const root = el('div', 'sfb-consent');
  const card = el('div', 'sfb-consent-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', `${uid}-title`);
  card.setAttribute('aria-describedby', `${uid}-intro`);
  card.tabIndex = -1;

  const title = el('h2', 'sfb-consent-title', 'Your data, your choice');
  title.id = `${uid}-title`;
  const intro = el(
    'p',
    'sfb-consent-intro',
    'We now store some of your work on our servers. Here is what we keep, and one optional thing you can choose to share.',
  );
  intro.id = `${uid}-intro`;

  const always = el('section', 'sfb-consent-section');
  always.append(
    el('h3', 'sfb-consent-h', 'Always, to make the app work'),
    list([
      'Your sign-in.',
      'Rockets you save to your account.',
      'Fixes you make to an imported file, kept so the file opens your way next time.',
      'Simulations you ask our server to run are processed there and not kept unless you save them.',
    ]),
  );

  const optional = el('section', 'sfb-consent-section');
  const row = el('label', 'sfb-consent-switch');
  const input = el('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.id = `${uid}-research`;
  input.checked = signedIn && Boolean(opts.current?.research);
  input.disabled = !signedIn;
  const track = el('span', 'sfb-consent-track');
  track.setAttribute('aria-hidden', 'true');
  track.append(el('span', 'sfb-consent-thumb'));
  row.append(input, track, el('span', 'sfb-consent-switch-label', 'Help improve the importer'));

  const detail = el('div', 'sfb-consent-detail');
  detail.id = `${uid}-detail`;
  input.setAttribute('aria-describedby', detail.id);
  detail.append(
    el(
      'p',
      '',
      'The rocket files you upload, the fixes you make to how we drew them, and your flight results are stored and used to train our rocket-building model.',
    ),
    el('p', '', 'Your name and email are never part of that data.'),
    el('p', '', 'You can turn this off at any time and it stops from then on.'),
  );
  optional.append(row, detail);
  if (!signedIn) {
    optional.append(el('p', 'sfb-consent-note', 'Sign in to take part'));
  }

  const guest = signedIn ? null : el('p', 'sfb-consent-guest', 'As a guest, your data stays in this browser.');

  const actions = el('div', 'sfb-consent-actions');
  const save = el('button', 'sfb-consent-btn sfb-consent-primary', 'Save my choice');
  save.type = 'button';
  const decline = el('button', 'sfb-consent-btn', 'No thanks');
  decline.type = 'button';
  actions.append(decline, save);

  const foot = el('p', 'sfb-consent-foot', 'You can change this later from your account menu.');

  card.append(title, intro, always, optional);
  if (guest) card.append(guest);
  card.append(actions, foot);
  root.append(card);

  return new Promise<ConsentState>((resolve) => {
    let done = false;
    const finish = (research: boolean) => {
      if (done) return;
      done = true;
      root.removeEventListener('keydown', onKey, true);
      root.remove();
      if (previous && previous.isConnected) previous.focus();
      resolve({ research: signedIn && research, version: CONSENT_VERSION, decidedAt: Date.now() });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Escape closes without changing anything: a reopened dialog keeps the earlier answer
        // (it must not quietly withdraw an opt-in); a first-time dialog counts as "No thanks".
        finish(Boolean(opts.current?.research));
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!card.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    save.addEventListener('click', () => finish(input.checked));
    decline.addEventListener('click', () => finish(false));
    root.addEventListener('keydown', onKey, true);
    // Backdrop clicks are deliberately ignored: a consent choice must be made on purpose.

    parent.append(root);
    // First focus lands on the switch when it is usable, otherwise on the card itself.
    if (!input.disabled) input.focus();
    else card.focus();
  });
}
