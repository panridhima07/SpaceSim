import './style.css';
import './astraTheme.css';
import type {
  Flaw,
  FlawSeverity,
  FlightEvent,
  SimConfig,
  SimState,
  StressReport,
  SweepResult,
} from '../types';
import { STRESS_FLIGHT_COUNT } from '../physics/sweep';
import type { CameraMode, RocketInfo, ToggleName, UI, UICallbacks } from './uiTypes';
import { attachTilt } from './tilt';

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** Toasts leave in this long, shorter than the 220 ms they take to arrive. */
const TOAST_EXIT_MS = 150;

const BRAND_MARK =
  '<svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">' +
  '<path d="M16 3l6 17-6-3.6L10 20z" fill="currentColor"/>' +
  '<path d="M9 24h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
  '<b>Astra</b><i>Space Flight Builder</i>';

/** Short one-shot emphasis. No-op where the Web Animations API is missing (jsdom) or motion is reduced. */
function pulse(el: HTMLElement, keyframes: Keyframe[], duration: number): void {
  if (typeof el.animate !== 'function') return;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.animate(keyframes, { duration, easing: EASE_OUT });
}

/** Resistance past a bound: the further the drag, the less the content follows. */
function rubberBand(drag: number, size: number): number {
  return (1 - 1 / ((drag * 0.55) / size + 1)) * size;
}

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
const TOAST_MS = 3000;

/** Phone / small-screen HUD: portrait phones and landscape phones. */
const MOBILE_QUERY = '(max-width: 760px), (max-height: 500px)';
const LANDSCAPE_QUERY = '(max-height: 500px)';

const CAMERAS: { mode: CameraMode; label: string }[] = [
  { mode: 'pad', label: 'Pad' },
  { mode: 'chase', label: 'Chase' },
  { mode: 'onboard', label: 'Onboard' },
  { mode: 'map', label: 'Map' },
];

const CAMERA_INITIAL: Record<CameraMode, string> = {
  pad: 'P',
  chase: 'C',
  onboard: 'O',
  map: 'M',
};

const TOGGLES: { name: ToggleName; label: string }[] = [
  { name: 'cutaway', label: 'Cutaway' },
  { name: 'forces', label: 'Forces' },
  { name: 'markers', label: 'CG·CP' },
  { name: 'trail', label: 'Trail' },
];

type TabName = 'rocket' | 'launch' | 'flaws' | 'log' | 'view';

const TABS: { name: TabName; label: string }[] = [
  { name: 'rocket', label: 'Rocket' },
  { name: 'launch', label: 'Launch' },
  { name: 'flaws', label: 'Flaws' },
  { name: 'log', label: 'Log' },
  { name: 'view', label: 'View' },
];

const SEVERITY_LABEL: Record<FlawSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const STRESS_LABEL: Record<SweepResult['worst'], string> = {
  ok: 'OK',
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

export interface CreateUIOptions {
  /** Test hook: build the phone HUD structure regardless of the viewport. */
  forceMobile?: boolean;
}

// ---------- DOM helpers ----------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Flat button. `cls` adds extra classes on top of `sfb-btn`. */
function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = h('button', cls ? `sfb-btn ${cls}` : 'sfb-btn', label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', () => {
    onClick();
    // Drop focus so a later Space/keyboard shortcut is not swallowed by the button.
    b.blur();
  });
  return b;
}

/** Replaces the children of `parent` with `nodes`. Re-parents existing nodes without cloning them. */
function fill(parent: HTMLElement, nodes: Node[]): void {
  parent.textContent = '';
  parent.append(...nodes);
}

/** Writes textContent only when the value changed. Keeps the per-frame path cheap. */
interface TextCell {
  el: HTMLElement;
  last: string;
}

function textCell(el: HTMLElement): TextCell {
  return { el, last: '' };
}

function setText(c: TextCell, value: string): void {
  if (value !== c.last) {
    c.last = value;
    c.el.textContent = value;
  }
}

function onMediaChange(mql: MediaQueryList | null, fn: () => void): void {
  if (!mql) return;
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', fn);
  else mql.addListener(fn);
}

function fmtAltitude(m: number): string {
  return Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function stabilityClass(cal: number): string {
  if (!Number.isFinite(cal)) return '';
  if (cal < 1) return 'sfb-stab-critical';
  if ((cal >= 1 && cal <= 1.5) || cal > 3) return 'sfb-stab-warning';
  return 'sfb-stab-good';
}

function numberField(
  label: string,
  unit: string,
  value: string,
  step: string,
  min?: string,
  placeholder?: string,
): { el: HTMLLabelElement; input: HTMLInputElement } {
  const input = h('input', 'sfb-input');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.value = value;
  input.step = step;
  if (min !== undefined) input.min = min;
  if (placeholder) input.placeholder = placeholder;

  const name = h('span', 'sfb-field-label', `${label} `);
  name.append(h('span', undefined, unit));

  const el = h('label', 'sfb-field');
  el.append(name, input);
  return { el, input };
}

function parseNum(input: HTMLInputElement, fallback: number): number {
  const v = parseFloat(input.value);
  return Number.isFinite(v) ? v : fallback;
}

/** Fixed-point number, or an em dash when the value is unknown (NaN). */
function fmtNum(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

/** One row per flight: its flaw titles, for the row tooltip. */
function stressRowTitle(r: SweepResult): string {
  if (r.flaws.length === 0) return `${r.label}: no flaws`;
  return `${r.label}:\n${r.flaws.map((f) => f.title).join('\n')}`;
}

/** Results table for one sweep. `value` gives the swept setting shown in the first column. */
function stressTable(
  caption: string,
  firstHeader: string,
  runs: SweepResult[],
  value: (r: SweepResult) => string,
): HTMLElement {
  const block = h('div', 'sfb-stress-block');
  block.append(h('h3', 'sfb-stress-caption', caption));

  const table = h('table', 'sfb-stress-table');
  const head = h('tr');
  for (const c of [firstHeader, 'Apogee m', 'Rail exit m/s', 'Drift m', 'Landing m/s', 'Result']) {
    head.append(h('th', undefined, c));
  }
  const thead = h('thead');
  thead.append(head);
  table.append(thead);

  const body = h('tbody');
  for (const r of runs) {
    const row = h('tr');
    row.title = stressRowTitle(r);
    const result = h('td');
    result.append(h('span', `sfb-pill sfb-stress-pill sfb-stress-${r.worst}`, STRESS_LABEL[r.worst]));
    row.append(
      h('td', undefined, value(r)),
      h('td', undefined, fmtNum(r.apogee, 0)),
      h('td', undefined, fmtNum(r.railExitSpeed, 1)),
      h('td', undefined, fmtNum(r.drift, 0)),
      h('td', undefined, fmtNum(r.landingSpeed, 1)),
      result,
    );
    body.append(row);
  }
  table.append(body);
  block.append(table);
  return block;
}

// ---------- UI ----------

/**
 * Builds the HUD. On a phone-sized viewport (see MOBILE_QUERY) the same panel DOM is
 * re-parented into a top strip, a bottom bar and a bottom sheet with tabs; on desktop
 * it lives in the left/right/bottom columns exactly as before. Every UI method works in both.
 */
export function createUI(container: HTMLElement, cb: UICallbacks, opts: CreateUIOptions = {}): UI {
  const root = h('div', 'sfb-root');

  // ===== Brand (top-left on desktop; first tab on phones) =====
  const brand = h('section', 'sfb-panel sfb-brand');
  const title = h('h1', 'sfb-title');
  title.innerHTML = BRAND_MARK;
  title.setAttribute('aria-label', 'Astra Space Flight Builder');
  const fileInput = h('input', 'sfb-hidden');
  fileInput.type = 'file';
  // Android's picker only lists .ork files when the MIME types are included too.
  fileInput.accept = '.ork,.eng,.xml,application/zip,application/octet-stream';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // allow choosing the same file again
    if (file) cb.onFile(file);
  });
  const buildBtn = button('Build Rocket', 'sfb-btn-primary sfb-btn-wide', () => cb.onBuild?.(), 'Open the rocket builder');
  const brandRow = h('div', 'sfb-row');
  brandRow.append(
    buildBtn,
    button('Open .ork', '', () => fileInput.click(), 'Open an OpenRocket file'),
    button('Load sample', '', () => cb.onLoadSample(), 'Load the built-in sample rocket'),
    button('Moon landing', 'sfb-btn-ghost sfb-btn-wide', () => window.location.assign('./landing.html'), 'Fly a lunar landing'),
  );
  brand.append(title, brandRow, fileInput);

  // ===== Left column: Rocket + Launch =====
  const left = h('div', 'sfb-left');

  const rocketPanel = h('section', 'sfb-panel');
  rocketPanel.append(h('h2', 'sfb-section-title', 'Rocket'));
  const rocketHint = h('p', 'sfb-hint', 'Drop an OpenRocket .ork file');
  const rocketBody = h('div', 'sfb-hidden');
  const rocketName = h('p', 'sfb-rocket-name');
  const kv = h('dl', 'sfb-kv');
  const vLength = h('dd');
  const vDiameter = h('dd');
  const vMass = h('dd');
  const vStability = h('dd');
  kv.append(
    h('dt', undefined, 'Length'), vLength,
    h('dt', undefined, 'Diameter'), vDiameter,
    h('dt', undefined, 'Mass'), vMass,
    h('dt', undefined, 'Stability margin'), vStability,
  );

  const motorSelect = h('select', 'sfb-select');
  motorSelect.setAttribute('aria-label', 'Motor');
  motorSelect.addEventListener('change', () => cb.onMotor(motorSelect.value));
  const motorWrap = h('div', 'sfb-motor');
  motorWrap.append(h('span', 'sfb-motor-label', 'Motor'), motorSelect);

  const warnBox = h('details', 'sfb-warnings sfb-hidden');
  const warnSummary = h('summary');
  const warnList = h('ul');
  warnBox.append(warnSummary, warnList);

  rocketBody.append(rocketName, kv, motorWrap, warnBox);
  rocketPanel.append(rocketHint, rocketBody);

  const launchPanel = h('section', 'sfb-panel');
  launchPanel.append(h('h2', 'sfb-section-title', 'Launch'));
  const railF = numberField('Rail length', 'm', '1', '0.1', '0');
  const angleF = numberField('Rail angle', 'deg', '0', '1', '0');
  const azimuthF = numberField('Rail azimuth', 'deg', '0', '1');
  const windSpeedF = numberField('Wind speed', 'm/s', '2', '0.5', '0');
  const windFromF = numberField('Wind from', 'deg', '270', '5');
  const gustF = numberField('Gust', '%', '20', '5', '0');
  const delayF = numberField('Ejection delay', 's', '', '0.1', '0', "motor's");
  const launchGrid = h('div', 'sfb-launch-grid');
  launchGrid.append(
    railF.el, angleF.el, azimuthF.el, windSpeedF.el, windFromF.el, gustF.el, delayF.el,
  );
  launchPanel.append(launchGrid);

  left.append(rocketPanel, launchPanel);

  function getConfig(): SimConfig {
    const cfg: SimConfig = {
      railLength: parseNum(railF.input, 1),
      railAngle: parseNum(angleF.input, 0) * RAD_PER_DEG,
      railAzimuth: parseNum(azimuthF.input, 0) * RAD_PER_DEG,
      windSpeed: parseNum(windSpeedF.input, 2),
      windDirection: parseNum(windFromF.input, 270) * RAD_PER_DEG,
      gust: parseNum(gustF.input, 20) / 100,
      launchAltitude: 0,
      ejectionDelay: undefined,
    };
    const delayText = delayF.input.value.trim();
    if (delayText !== '') {
      const v = parseFloat(delayText);
      if (Number.isFinite(v)) cfg.ejectionDelay = v;
    }
    return cfg;
  }

  const emitConfig = (): void => cb.onConfig(getConfig());
  for (const f of [railF, angleF, azimuthF, windSpeedF, windFromF, gustF, delayF]) {
    f.input.addEventListener('input', emitConfig);
  }

  // ===== Right column: telemetry, flight log, design flaws =====
  const right = h('div', 'sfb-right');

  const telePanel = h('section', 'sfb-panel');
  const clockRow = h('div', 'sfb-telemetry-clock');
  const clockEl = h('span', 'sfb-clock', 'T+0.0');
  const phaseEl = h('span', 'sfb-phase', 'PAD');
  clockRow.append(clockEl, phaseEl);
  const teleList = h('dl', 'sfb-tele');
  const teleRow = (label: string): TextCell => {
    const dd = h('dd', undefined, '');
    const cell = h('div', 'sfb-cell');
    cell.append(h('dt', undefined, label), dd);
    teleList.append(cell);
    return textCell(dd);
  };
  const tAlt = teleRow('Altitude');
  const tSpeed = teleRow('Speed');
  const tMach = teleRow('Mach');
  const tAccel = teleRow('Acceleration');
  const tAoa = teleRow('Angle of attack');
  const tQ = teleRow('Dynamic pressure');
  const tStab = teleRow('Stability');
  const tThrust = teleRow('Thrust');
  telePanel.append(clockRow, teleList);

  const clockCell = textCell(clockEl);
  const phaseCell = textCell(phaseEl);

  // Compact readouts for the phone top strip. Own cells, written from the same values in setTelemetry.
  const chips = h('div', 'sfb-hud-chips');
  const readout = (label: string): TextCell => {
    const v = h('span', 'sfb-hud-v', '—');
    const chip = h('div', 'sfb-hud-chip');
    chip.append(h('span', 'sfb-hud-k', label), v);
    chips.append(chip);
    return textCell(v);
  };
  const cAlt = readout('ALT');
  const cSpeed = readout('SPD');
  const cAccel = readout('ACC');

  const logPanel = h('section', 'sfb-panel');
  logPanel.append(h('h2', 'sfb-section-title', 'Flight log'));
  const logEmpty = h('p', 'sfb-hint', 'No flight yet');
  const logList = h('ul', 'sfb-events sfb-hidden');
  logPanel.append(logEmpty, logList);

  const flawPanel = h('section', 'sfb-panel');
  flawPanel.append(h('h2', 'sfb-section-title', 'Design flaws'));
  const flawEmpty = h('p', 'sfb-hint', 'Fly the rocket to analyse it');
  const flawList = h('ul', 'sfb-flaws sfb-hidden');
  flawPanel.append(flawEmpty, flawList);

  const stressPanel = h('section', 'sfb-panel sfb-hidden');
  stressPanel.append(h('h2', 'sfb-section-title', 'Stress test'));
  const stressBody = h('div', 'sfb-stress');
  stressPanel.append(stressBody);

  right.append(telePanel, logPanel, flawPanel, stressPanel);

  // ===== Bottom dock: launch controls (bottom bar on phones) =====
  const dock = h('section', 'sfb-panel sfb-dock');

  const launchBtn = button('Launch', 'sfb-btn-primary sfb-btn-launch', () => {
    cb.onLaunch();
    // Confirm the press with one ring of light off the button.
    pulse(launchBtn, [
      { boxShadow: '0 0 0 0 rgba(127, 215, 255, 0.7)' },
      { boxShadow: '0 0 0 22px rgba(127, 215, 255, 0)' },
    ], 420);
  }, 'Launch (Space)');
  const resetBtn = button('Reset', '', () => cb.onReset(), 'Reset (R)');
  const pauseBtn = button('Pause', '', () => cb.onPause(), 'Pause / play (P)');
  let lastPaused: boolean | null = null;

  const warpLabel = h('span', 'sfb-warp-label', '×1');
  const warpDown = button('−', 'sfb-btn-icon', () => cb.onWarp(-1), 'Slower (,)');
  const warpUp = button('+', 'sfb-btn-icon', () => cb.onWarp(1), 'Faster (.)');
  let lastWarp: number | null = null;

  const warpGroup = h('div', 'sfb-dock-group');
  warpGroup.append(h('span', 'sfb-muted sfb-warp-tag', 'Warp'), warpDown, warpLabel, warpUp);

  let cameraMode: CameraMode = 'pad';
  const cameraButtons = new Map<CameraMode, HTMLButtonElement>();
  const cameraGroup = h('div', 'sfb-dock-group');
  for (const c of CAMERAS) {
    const b = button(c.label, '', () => selectCamera(c.mode), `Camera: ${c.label}`);
    cameraButtons.set(c.mode, b);
    cameraGroup.append(b);
  }

  function markCamera(mode: CameraMode): void {
    cameraMode = mode;
    for (const [m, b] of cameraButtons) {
      b.classList.toggle('is-active', m === mode);
    }
    cycleBtn.textContent = CAMERA_INITIAL[mode];
    cycleBtn.title = `Camera: ${CAMERAS.find((c) => c.mode === mode)?.label ?? mode}`;
  }

  function selectCamera(mode: CameraMode): void {
    markCamera(mode);
    cb.onCamera(mode);
  }

  function nextCamera(mode: CameraMode): CameraMode {
    const i = CAMERAS.findIndex((c) => c.mode === mode);
    return CAMERAS[(i + 1) % CAMERAS.length].mode;
  }

  const toggleState: Record<ToggleName, boolean> = {
    cutaway: false,
    forces: false,
    markers: false,
    trail: false,
  };
  const toggleGroup = h('div', 'sfb-dock-group');
  const toggleButtons = new Map<ToggleName, HTMLButtonElement>();
  for (const t of TOGGLES) {
    const b = button(t.label, '', () => {
      toggleState[t.name] = !toggleState[t.name];
      b.classList.toggle('is-active', toggleState[t.name]);
      b.setAttribute('aria-pressed', String(toggleState[t.name]));
      cb.onToggle(t.name, toggleState[t.name]);
    }, `Toggle ${t.label}`);
    b.setAttribute('aria-pressed', 'false');
    toggleButtons.set(t.name, b);
    toggleGroup.append(b);
  }

  /** Dock state only, for a flaw jump that the app applies itself. */
  function setToggleVisual(name: ToggleName, on: boolean): void {
    toggleState[name] = on;
    const b = toggleButtons.get(name);
    if (!b) return;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  }

  const stressGroup = h('div', 'sfb-dock-group');
  stressGroup.append(
    button('Stress test', '', () => cb.onStressTest(), 'Fly many headless flights over wind, rail angle and ejection delay'),
  );

  const sep = (): HTMLElement => h('span', 'sfb-dock-sep');

  // ===== Replay scrubber =====
  const replay = h('section', 'sfb-panel sfb-replay sfb-hidden');
  const scrub = h('input', 'sfb-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = '0';
  scrub.step = '0.02';
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'Replay time');
  scrub.addEventListener('input', () => cb.onScrub(parseFloat(scrub.value)));
  const replayTime = h('span', 'sfb-replay-time', '');
  const replayTimeCell = textCell(replayTime);
  replay.append(scrub, replayTime);
  let replayDuration = 0;

  // ===== Toasts and drop highlight =====
  const toasts = h('div', 'sfb-toasts');
  const dropHint = h('div', 'sfb-drop', 'Drop file to open');

  // ===== Phone HUD: top strip, right rail, bottom sheet =====
  const topBar = h('div', 'sfb-hud-bar');
  topBar.setAttribute('role', 'button');
  topBar.setAttribute('aria-expanded', 'false');
  const topExpand = h('div', 'sfb-hud-expand');
  const topStrip = h('section', 'sfb-hud sfb-hud-top');
  topStrip.append(topBar, topExpand);
  topStrip.addEventListener('click', () => {
    const open = topStrip.classList.toggle('is-expanded');
    topBar.setAttribute('aria-expanded', String(open));
  });

  const cycleBtn = button(CAMERA_INITIAL.pad, 'sfb-hud-btn sfb-hud-cam', () => selectCamera(nextCamera(cameraMode)), 'Camera');
  cycleBtn.setAttribute('aria-label', 'Next camera');
  const badge = h('span', 'sfb-badge sfb-hidden');
  const menuBtn = button('≡', 'sfb-hud-btn sfb-hud-menu', () => {
    if (sheetIsOpen()) closeSheet();
    else openSheet();
  }, 'Menu');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.append(badge);
  const buildRailBtn = button('B', 'sfb-hud-btn sfb-hud-build', () => cb.onBuild?.(), 'Build Rocket');
  buildRailBtn.setAttribute('aria-label', 'Build rocket');
  const rail = h('div', 'sfb-hud sfb-hud-rail');
  rail.append(buildRailBtn, cycleBtn, menuBtn);

  const tabPages = new Map<TabName, HTMLElement>();
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  const sheetBody = h('div', 'sfb-sheet-body');
  const tabBar = h('div', 'sfb-tabs');
  tabBar.setAttribute('role', 'tablist');
  for (const t of TABS) {
    const page = h('div', `sfb-tabpage sfb-tabpage-${t.name}`);
    page.setAttribute('role', 'tabpanel');
    tabPages.set(t.name, page);
    sheetBody.append(page);

    const tb = h('button', 'sfb-tab', t.label);
    tb.type = 'button';
    tb.setAttribute('role', 'tab');
    tb.addEventListener('click', () => setTab(t.name));
    tabButtons.set(t.name, tb);
    tabBar.append(tb);
  }
  const pageOf = (name: TabName): HTMLElement => tabPages.get(name) as HTMLElement;

  const handle = h('div', 'sfb-sheet-handle');
  handle.setAttribute('aria-hidden', 'true');
  // Drag the handle down to close the sheet. The sheet follows the finger with no easing
  // while held, and resists when pulled up past its open position.
  handle.addEventListener('pointerdown', (e) => {
    const y0 = e.clientY;
    sheet.classList.add('is-held');
    const move = (ev: PointerEvent): void => {
      const dy = ev.clientY - y0;
      sheet.style.transform = `translateY(${dy >= 0 ? dy : -rubberBand(-dy, 90)}px)`;
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // Hand back to the stylesheet: it springs to open or slides shut from where it is.
      sheet.classList.remove('is-held');
      sheet.style.transform = '';
      if (ev.clientY - y0 > 40) closeSheet();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  const closeBtn = h('button', 'sfb-sheet-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close menu');
  closeBtn.addEventListener('click', () => closeSheet());
  const sheetRow = h('div', 'sfb-sheet-row');
  sheetRow.append(tabBar, closeBtn);
  const sheetHead = h('div', 'sfb-sheet-head');
  sheetHead.append(handle, sheetRow);
  const sheet = h('section', 'sfb-hud sfb-sheet');
  sheet.setAttribute('aria-label', 'Menu');
  sheet.append(sheetHead, sheetBody);

  root.append(left, right, brand, dock, replay, toasts, dropHint, topStrip, rail, sheet);

  // The dock wraps to a second row on narrower windows. Publish its height so the side
  // columns always end above it instead of sliding underneath.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      root.style.setProperty('--sfb-dock-h', `${dock.offsetHeight}px`);
    }).observe(dock);
  }
  container.append(root);
  attachTilt([left, right, dock, replay]);

  // ===== Sheet state =====

  function sheetIsOpen(): boolean {
    return sheet.classList.contains('is-open');
  }

  function setTab(name: TabName): void {
    for (const [n, p] of tabPages) p.classList.toggle('is-active', n === name);
    for (const [n, b] of tabButtons) {
      const on = n === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    sheetBody.scrollTop = 0;
  }

  function openSheet(tab?: TabName): void {
    if (tab) setTab(tab);
    sheet.classList.add('is-open');
    menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSheet(): void {
    sheet.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  setTab('rocket');

  // ===== Layout: desktop columns vs. phone HUD =====
  // Both layouts re-parent the same panel nodes, so each cell and control exists once.

  let isMobile: boolean | null = null;
  const dockLeft = h('div', 'sfb-dock-left');

  function layoutDesktop(): void {
    fill(left, [brand, rocketPanel, launchPanel]);
    fill(telePanel, [clockRow, teleList]);
    fill(right, [telePanel, logPanel, flawPanel, stressPanel]);
    fill(dock, [
      launchBtn, resetBtn, pauseBtn, sep(),
      warpGroup, sep(),
      cameraGroup, sep(),
      toggleGroup, sep(),
      stressGroup,
    ]);
  }

  function layoutMobile(): void {
    fill(topBar, [clockRow, chips]);
    fill(topExpand, [telePanel]);
    fill(pageOf('rocket'), [brand, rocketPanel]);
    fill(pageOf('launch'), [launchPanel]);
    fill(pageOf('flaws'), [flawPanel, stressGroup, stressPanel]);
    fill(pageOf('log'), [logPanel]);
    fill(pageOf('view'), [cameraGroup, toggleGroup]);
    // Bottom bar: Reset and Pause left of the round Launch button, warp on the right.
    fill(dockLeft, [resetBtn, pauseBtn]);
    fill(dock, [dockLeft, launchBtn, warpGroup]);
    fill(left, []);
    fill(right, []);
  }

  function applyMode(mobile: boolean, landscape: boolean): void {
    root.classList.toggle('sfb-mobile', mobile);
    root.classList.toggle('sfb-landscape', mobile && landscape);
    if (mobile === isMobile) return;
    isMobile = mobile;
    if (mobile) {
      layoutMobile();
    } else {
      layoutDesktop();
      closeSheet();
    }
  }

  // ===== Events =====

  // Keyboard shortcuts. Ignored while typing in form fields or when hidden (build mode).
  window.addEventListener('keydown', (e) => {
    if (root.classList.contains('sfb-hidden')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        if (!e.repeat) cb.onLaunch();
        break;
      case 'r':
      case 'R':
        cb.onReset();
        break;
      case 'p':
      case 'P':
        cb.onPause();
        break;
      case ',':
        cb.onWarp(-1);
        break;
      case '.':
        cb.onWarp(1);
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        selectCamera(CAMERAS[Number(e.key) - 1].mode);
        break;
      case 'Escape':
        if (sheetIsOpen()) closeSheet();
        break;
      default:
        break;
    }
  });
  // Stop a focused dock button from also firing on the Space keyup.
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName === 'BUTTON') {
      e.preventDefault();
    }
  });

  // Tapping the 3D view (outside the HUD) closes the sheet. A drag that rotates the camera does not.
  let tapStart: { x: number; y: number } | null = null;
  window.addEventListener('pointerdown', (e) => {
    tapStart = root.contains(e.target as Node) ? null : { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', (e) => {
    const start = tapStart;
    tapStart = null;
    if (!start || !isMobile || !sheetIsOpen()) return;
    if (root.contains(e.target as Node)) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
    closeSheet();
  });

  // Drag and drop of files anywhere in the window.
  let dragDepth = 0;
  const isFileDrag = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    root.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    root.classList.remove('is-dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) cb.onFile(file);
  });

  // ===== Flaw and flight-log state =====
  let flaws: Flaw[] = [];
  let hasFlown = false;
  let flightOver = false;

  let renderedFlaws: Flaw[] | null = null;

  function renderFlaws(): void {
    flawList.textContent = '';
    // Cards cascade in for a new analysis only, not for each rebuild during a flight.
    flawList.classList.toggle('is-fresh', flaws !== renderedFlaws);
    renderedFlaws = flaws;
    if (flaws.length === 0) {
      flawList.classList.add('sfb-hidden');
      flawEmpty.classList.remove('sfb-hidden');
      flawEmpty.textContent = flightOver ? 'No flaws found' : hasFlown ? 'Analysing when the flight ends' : 'Fly the rocket to analyse it';
      return;
    }
    flawEmpty.classList.add('sfb-hidden');
    flawList.classList.remove('sfb-hidden');
    for (const f of flaws) {
      const li = h('li', `sfb-flaw sev-${f.severity}`);
      li.append(h('span', 'sfb-pill', SEVERITY_LABEL[f.severity] ?? f.severity));
      li.append(h('p', 'sfb-flaw-title', f.title));
      li.append(h('p', 'sfb-flaw-detail', f.detail));
      const fix = h('p', 'sfb-flaw-fix');
      fix.append(h('b', undefined, 'Fix: '), document.createTextNode(f.fix));
      li.append(fix);
      if (typeof f.t === 'number' && Number.isFinite(f.t)) {
        li.append(
          button(`Jump to T+${f.t.toFixed(1)} s`, 'sfb-btn-link', () => {
            // The app switches to forces and chase for a flaw jump; mirror that on the dock.
            setToggleVisual('forces', true);
            markCamera('chase');
            cb.onFlawClick(f);
            // Show the replay, not the menu.
            if (isMobile) closeSheet();
          }),
        );
      }
      flawList.append(li);
    }
  }

  /** Badge on the menu button: red when any flaw is critical, amber otherwise. */
  function updateBadge(): void {
    if (flaws.length === 0) {
      badge.classList.add('sfb-hidden');
      menuBtn.setAttribute('aria-label', 'Menu');
      return;
    }
    const hot = flaws.some((f) => f.severity === 'critical');
    badge.textContent = String(flaws.length);
    badge.classList.toggle('is-critical', hot);
    badge.classList.toggle('is-warning', !hot);
    badge.classList.remove('sfb-hidden');
    menuBtn.setAttribute('aria-label', `Menu, ${flaws.length} design flaws`);
  }

  // ===== UI =====
  const ui: UI = {
    setRocket(info: RocketInfo | null): void {
      if (!info) {
        rocketHint.classList.remove('sfb-hidden');
        rocketBody.classList.add('sfb-hidden');
        return;
      }
      rocketHint.classList.add('sfb-hidden');
      rocketBody.classList.remove('sfb-hidden');

      rocketName.textContent = info.name || 'Unnamed rocket';
      vLength.textContent = `${(info.length * 100).toFixed(1)} cm`;
      vDiameter.textContent = `${(info.diameter * 1000).toFixed(1)} mm`;
      vMass.textContent = `${(info.mass * 1000).toFixed(0)} g`;
      vStability.textContent = `${info.stabilityCal.toFixed(2)} cal`;
      vStability.className = stabilityClass(info.stabilityCal);

      if (info.motor !== null) {
        const hasOption = Array.from(motorSelect.options).some((o) => o.value === info.motor);
        if (hasOption) motorSelect.value = info.motor;
      }

      const warnings = info.warnings ?? [];
      warnBox.classList.toggle('sfb-hidden', warnings.length === 0);
      warnSummary.textContent = `Warnings (${warnings.length})`;
      warnList.textContent = '';
      for (const w of warnings) warnList.append(h('li', undefined, w));
    },

    setMotors(list: { designation: string; label: string }[], selected: string | null): void {
      motorSelect.textContent = '';
      if (list.length === 0) {
        const none = new Option('No motors', '');
        none.disabled = true;
        motorSelect.append(none);
        motorSelect.disabled = true;
        return;
      }
      motorSelect.disabled = false;
      for (const m of list) {
        motorSelect.append(new Option(m.label, m.designation));
      }
      const exists = selected !== null && list.some((m) => m.designation === selected);
      motorSelect.selectedIndex = exists
        ? list.findIndex((m) => m.designation === selected)
        : 0;
    },

    setTelemetry(s: SimState, warp: number, paused: boolean): void {
      setText(clockCell, `T+${s.t.toFixed(1)}`);
      const phase = s.phase.toUpperCase();
      if (phase !== phaseCell.last && phaseCell.last !== '') {
        // A new flight phase pops once so the change is seen without reading the label.
        pulse(phaseEl, [{ transform: 'scale(1.2)' }, { transform: 'scale(1)' }], 280);
      }
      setText(phaseCell, phase);
      setText(tAlt, fmtAltitude(s.altitude));
      setText(tSpeed, `${s.speed.toFixed(1)} m/s`);
      setText(tMach, s.mach.toFixed(2));
      setText(tAccel, `${s.accelG.toFixed(1)} g`);
      setText(tAoa, `${(s.alpha * DEG_PER_RAD).toFixed(1)}°`);
      setText(tQ, `${(s.dynamicPressure / 1000).toFixed(2)} kPa`);
      setText(tStab, `${s.stabilityCal.toFixed(2)} cal`);
      setText(tThrust, `${Math.round(s.thrust)} N`);

      // Phone top strip: the same values, compact.
      setText(cAlt, fmtAltitude(s.altitude));
      setText(cSpeed, `${s.speed.toFixed(1)} m/s`);
      setText(cAccel, `${s.accelG.toFixed(1)} g`);

      if (warp !== lastWarp) {
        lastWarp = warp;
        warpLabel.textContent = `×${warp}`;
      }
      if (paused !== lastPaused) {
        lastPaused = paused;
        pauseBtn.textContent = paused ? 'Play' : 'Pause';
      }
    },

    setEvents(events: FlightEvent[]): void {
      hasFlown = events.length > 0;
      flightOver = events.some((e) => e.type === 'landing' || e.type === 'crash');
      if (flaws.length === 0) renderFlaws();
      logList.textContent = '';
      logEmpty.classList.toggle('sfb-hidden', hasFlown);
      logList.classList.toggle('sfb-hidden', !hasFlown);
      for (const ev of events) {
        const li = h('li');
        li.append(
          h('span', 'sfb-ev-t', `T+${ev.t.toFixed(2)}`),
          h('span', 'sfb-ev-name', ev.message || ev.type),
          h('span', 'sfb-ev-alt', fmtAltitude(ev.altitude)),
          h('span', 'sfb-ev-speed', `${ev.speed.toFixed(0)} m/s`),
        );
        logList.append(li);
      }
      // The empty-state text of the flaws panel depends on whether a flight happened.
      renderFlaws();
    },

    setFlaws(list: Flaw[]): void {
      // A new, non-empty analysis after the flight ended opens the Flaws tab on phones.
      const fresh = list !== flaws && list.length > 0 && flightOver;
      flaws = list;
      renderFlaws();
      updateBadge();
      if (fresh && isMobile) openSheet('flaws');
    },

    setStress(report: StressReport | null | 'running'): void {
      stressBody.textContent = '';
      if (report === null) {
        stressPanel.classList.add('sfb-hidden');
        return;
      }
      stressPanel.classList.remove('sfb-hidden');
      if (report === 'running') {
        stressBody.append(h('p', 'sfb-hint', `Running ${STRESS_FLIGHT_COUNT} flights…`));
        return;
      }
      for (const line of report.summary) stressBody.append(h('p', 'sfb-stress-line', line));
      stressBody.append(
        stressTable('Wind', 'Wind m/s', report.wind, (r) => fmtNum(r.config.windSpeed, 0)),
        stressTable(
          'Rail angle',
          'Angle deg',
          report.railAngle,
          (r) => fmtNum(r.config.railAngle * (180 / Math.PI), 0),
        ),
        stressTable(
          'Ejection delay',
          'Delay s',
          report.delay,
          (r) => fmtNum(r.config.ejectionDelay ?? NaN, 0),
        ),
      );
    },

    setReplay(duration: number, t: number): void {
      if (!(duration > 0)) {
        replayDuration = 0;
        replay.classList.add('sfb-hidden');
        return;
      }
      replay.classList.remove('sfb-hidden');
      if (duration !== replayDuration) {
        replayDuration = duration;
        scrub.max = String(duration);
      }
      if (document.activeElement !== scrub) {
        scrub.value = String(Math.min(Math.max(t, 0), duration));
      }
      setText(replayTimeCell, `T+${t.toFixed(2)} / ${duration.toFixed(2)} s`);
    },

    toast(msg: string): void {
      const t = h('div', 'sfb-toast', msg);
      toasts.append(t);
      window.setTimeout(() => t.classList.add('is-leaving'), TOAST_MS - TOAST_EXIT_MS);
      window.setTimeout(() => t.remove(), TOAST_MS);
    },

    getConfig,

    setVisible(visible: boolean): void {
      root.classList.toggle('sfb-hidden', !visible);
      if (!visible && isMobile) closeSheet();
    },

    setBuildLabel(label: string): void {
      buildBtn.textContent = label;
    },
  };

  // ===== Viewport switching (last, once every binding above exists) =====
  const forced = opts.forceMobile === true;
  const canMatch = !forced && typeof window.matchMedia === 'function';
  const mobileMql = canMatch ? window.matchMedia(MOBILE_QUERY) : null;
  const landscapeMql = canMatch ? window.matchMedia(LANDSCAPE_QUERY) : null;
  const syncViewport = (): void =>
    applyMode(forced || (mobileMql?.matches ?? false), !forced && (landscapeMql?.matches ?? false));
  onMediaChange(mobileMql, syncViewport);
  onMediaChange(landscapeMql, syncViewport);
  syncViewport();

  return ui;
}
