import './motion.css';
import './hero.css';

export interface HeroOptions {
  /** Primary button: open the rocket builder. */
  onBuild: () => void;
  /** Secondary button: dismiss the title and show the launch pad. */
  onFly: () => void;
  /** Third button: go to the Moon landing page. */
  onMoon: () => void;
  /** Fourth button: open LVM3-M4 mission mode. */
  onMission?: () => void;
}

export interface Hero {
  /** Fade the title out and remove it from the DOM. Safe to call twice. */
  dismiss(): void;
}

const SEEN_KEY = 'astra-hero-seen';
const LOAD_FILL_MS = 900;
const LOAD_FADE_MS = 600;
const TITLE_OUT_MS = 1000;

function hasSeen(): boolean {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) !== null;
  } catch {
    // sessionStorage can throw in private windows; treat as not seen.
    return false;
  }
}

function markSeen(): void {
  try {
    window.sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Ignore: the title will simply show again on the next visit.
  }
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(variant: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = make('button', `astra-hero-btn ${variant}`, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function buildLoading(): { root: HTMLDivElement; fill: HTMLElement } {
  const root = make('div', 'astra-load');
  const box = make('div', 'astra-load-in');

  const heading = make('h1');
  heading.append('ASTRA ', make('span', undefined, 'SPACEFLIGHT'));

  const bar = make('div', 'astra-load-bar');
  const fill = make('i', 'astra-load-fill');
  bar.append(fill);

  const msg = make('p', 'astra-load-msg', 'Preparing the launch site…');

  box.append(heading, bar, msg);
  root.append(box);
  return { root, fill };
}

/**
 * Shows the loading bar, then the title. Returns null (and shows nothing)
 * when the title was already seen in this browser session.
 */
export function mountHero(container: HTMLElement, opts: HeroOptions): Hero | null {
  if (hasSeen()) return null;

  const { root: loading, fill } = buildLoading();
  let title: HTMLDivElement | null = null;
  let dismissed = false;
  let rafId = 0;
  const timers: number[] = [];

  function dismiss(): void {
    if (dismissed) return;
    dismissed = true;
    markSeen();

    window.cancelAnimationFrame(rafId);
    for (const id of timers) window.clearTimeout(id);
    document.removeEventListener('keydown', onKey);

    // Dismissed during the loading bar: the title never appears.
    loading.remove();

    if (title) {
      const node = title;
      node.classList.add('is-out');
      window.setTimeout(() => node.remove(), TITLE_OUT_MS);
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.repeat) return;
    // A focused control handles Enter itself (title buttons, the account button, form fields).
    if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea, [role=button]')) return;
    e.preventDefault();
    dismiss();
    opts.onFly();
  }

  function showTitle(): void {
    const overlay = make('div', 'astra-hero');
    const content = make('div', 'astra-hero-content');

    const kicker = make('p', 'astra-hero-kicker', 'ASTRA 2026 · VIT BHOPAL');

    const heading = make('h1', 'astra-hero-title');
    heading.append('ASTRA ', make('span', undefined, 'SPACEFLIGHT'));

    const tag = make('p', 'astra-hero-tag');
    ['BUILD.', 'LAUNCH.', 'EXPLORE.', 'LAND.'].forEach((word, i) => {
      if (i > 0) tag.append(' ');
      tag.append(make('b', undefined, word));
    });

    const sub = make(
      'p',
      'astra-hero-sub',
      'Design a rocket part by part, fly it with real aerodynamics, find its flaws, then try a powered landing on the Moon.',
    );

    const cta = make('div', 'astra-hero-cta');
    cta.append(
      makeButton('astra-hero-btn--primary', 'BUILD A ROCKET', () => {
        dismiss();
        opts.onBuild();
      }),
      makeButton('astra-hero-btn--ghost', 'TRY THE SAMPLE ROCKET', () => {
        dismiss();
        opts.onFly();
      }),
      makeButton('astra-hero-btn--ghost', 'MOON LANDING', () => {
        opts.onMoon();
      }),
      makeButton('astra-hero-btn--ghost', "FLY ISRO'S LVM3", () => {
        dismiss();
        opts.onMission?.();
      }),
    );

    const hint = make(
      'p',
      'astra-hero-hint',
      'You can open an OpenRocket .ork file at any time',
    );

    content.append(kicker, heading, tag, sub, cta, hint);
    overlay.append(content);

    title = overlay;
    container.append(overlay);
    document.addEventListener('keydown', onKey);
  }

  container.append(loading);

  // Commit width 0 before switching to 100% so the CSS transition runs.
  rafId = window.requestAnimationFrame(() => {
    void fill.offsetWidth;
    fill.style.width = '100%';
  });

  // The title mounts under the loading overlay as it starts to fade, so the two cross-fade
  // and the launch pad never flashes in between.
  timers.push(
    window.setTimeout(() => {
      showTitle();
      loading.classList.add('is-done');
    }, LOAD_FILL_MS),
  );
  timers.push(
    window.setTimeout(() => {
      loading.remove();
    }, LOAD_FILL_MS + LOAD_FADE_MS),
  );

  return { dismiss };
}
