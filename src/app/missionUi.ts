import './motion.css';
import './style.css';
import './mission.css';
import { thrustToWeight } from '../mission/adapter';
import type { FlightMarker, FlightRecord } from '../mission/record';
import type { FlightSnapshot } from '../mission/snapshot';
import { MISSIONS, getMission, type MissionDef } from '../mission/vehicles';
import type { MissionCameraMode } from './missionView';

export interface MissionUiCallbacks {
  onExit(): void;
  onMission(id: string): void;
  onFly(caseId: string): void;
  onPlayPause(): void;
  onWarp(warp: number): void;
  onScrub(t: number): void;
  onCamera(mode: MissionCameraMode): void;
}

export interface MissionUi {
  setVisible(on: boolean): void;
  setBusy(text: string | null): void;
  setError(msg: string | null): void;
  setRecord(record: FlightRecord, def: MissionDef): void;
  update(snapshot: FlightSnapshot, playing: boolean, warp: number): void;
  /** Show the camera's distance from what it is looking at, metres. */
  setViewScale(m: number): void;
}

const SCENARIOS: { id: string; label: string; note: string }[] = [
  { id: 'blocked-vent', label: 'Blocked vent', note: 'Fairing vents blocked; differential pressure spikes.' },
  { id: 'regulator-low', label: 'Regulator low', note: 'Tank pressurisation low; buckling & cavitation.' },
  { id: 'hot-grain', label: 'Hot grain', note: 'Solid booster grain over-temp; chamber overpressure.' },
];

const HEALTH_LABELS: Record<string, string> = {
  maxQ: 'Dynamic pressure',
  qAlpha: 'Q·alpha load',
  axialG: 'Axial acceleration',
  skin: 'Skin temperature',
  fairingDp: 'Fairing pressure difference',
  depressRate: 'Depressurisation rate',
  tankBurst: 'Tank burst margin',
  caseBurst: 'Case burst margin',
  tankBuckling: 'Tank buckling',
  cavitation: 'Pump cavitation',
  nozzle: 'Nozzle thermal',
  payloadHeat: 'Payload heating',
};

const WARPS = [1, 5, 20, 100] as const;
// Camera presets, nearest to farthest. The mouse wheel / pinch zooms continuously between them.
const CAMERAS: { mode: MissionCameraMode; label: string; hint: string }[] = [
  { mode: 'pad', label: 'Pad', hint: 'Ground camera beside the pad (1)' },
  { mode: 'chase', label: 'Chase', hint: 'Follow the rocket up close (2)' },
  { mode: 'track', label: 'Track', hint: 'Long-range tracking camera (3)' },
  { mode: 'earth', label: 'Earth', hint: 'Whole planet, following the rocket (4)' },
  { mode: 'solar', label: 'Solar', hint: 'Sun, planets and orbits (5)' },
];

/** Camera distance as short text: 45 m, 12.3 km, 384 000 km, 1.52 AU. */
export function formatViewDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 999.5) return `${Math.round(m)} m`;
  if (m < 99_950) return `${(m / 1000).toFixed(1)} km`;
  if (m < 1e10) return `${Math.round(m / 1000).toLocaleString('en-US').replace(/,/g, ' ')} km`;
  return `${(m / 149_597_870_700).toFixed(2)} AU`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtAlt(m: number): string {
  return Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** 'T-3.0 s' on the pad, 'T+70.0 s' in flight. */
export function formatMissionTime(t: number): string {
  const r = Math.round(t * 10) / 10;
  return `T${r < 0 ? '-' : '+'}${Math.abs(r).toFixed(1)} s`;
}

export function formatThrust(newtons: number): string {
  return newtons >= 999_500 ? `${(newtons / 1e6).toFixed(2)} MN` : `${Math.round(newtons / 1000)} kN`;
}

function fmtSpeed(mps: number): string {
  return Math.abs(mps) >= 1000 ? `${(mps / 1000).toFixed(2)} km/s` : `${Math.round(mps)} m/s`;
}

function fmtLatLon(latDeg: number, lonDeg: number): string {
  const ns = latDeg >= 0 ? 'N' : 'S';
  const ew = lonDeg >= 0 ? 'E' : 'W';
  return `${Math.abs(latDeg).toFixed(2)}°${ns}, ${Math.abs(lonDeg).toFixed(2)}°${ew}`;
}

/** 'gravityTurn' -> 'Gravity turn'. */
function phaseLabel(phase: string): string {
  const words = phase.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when a key press belongs to a form field or editable text, not to a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.isContentEditable || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export function createMissionUI(container: HTMLElement, callbacks: MissionUiCallbacks): MissionUi {
  const root = el('div', 'sfb-root msn-root sfb-hidden');

  // ---------- Header ----------
  const header = el('header', 'sfb-panel msn-header');
  const headerLeft = el('div', 'msn-header-left');
  const backBtn = el('button', 'sfb-btn', 'Back');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => callbacks.onExit());
  const vehicleTitle = el('h2', 'msn-vehicle-name', '');
  headerLeft.append(backBtn, vehicleTitle);

  const headerRight = el('div', 'msn-header-right');
  const missionSelect = el('select', 'sfb-select msn-select msn-mission-select');
  missionSelect.setAttribute('aria-label', 'Mission');
  for (const m of MISSIONS) {
    const opt = el('option', undefined, m.name);
    opt.value = m.id;
    missionSelect.append(opt);
  }
  const caseSelect = el('select', 'sfb-select msn-select');
  caseSelect.setAttribute('aria-label', 'Flight case');
  const caseNote = el('span', 'msn-case-note', '');
  const flyBtn = el('button', 'sfb-btn sfb-btn-primary', 'Fly');
  flyBtn.type = 'button';
  flyBtn.addEventListener('click', () => callbacks.onFly(caseSelect.value || 'nominal'));

  const sheetBtn = el('button', 'sfb-btn msn-sheet-toggle', 'Timeline & Health');
  sheetBtn.type = 'button';
  // The sheet starts below the header, so the button that closes it stays reachable.
  const placeSheet = (): void => {
    if (!root.classList.contains('msn-sheet-open')) return;
    const top = Math.round(header.getBoundingClientRect().bottom) + 8;
    root.style.setProperty('--msn-sheet-top', `${top}px`);
  };
  const setSheet = (open: boolean): void => {
    root.classList.toggle('msn-sheet-open', open);
    sheetBtn.setAttribute('aria-expanded', String(open));
    placeSheet();
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(placeSheet).observe(header);
  setSheet(false);
  sheetBtn.addEventListener('click', () => setSheet(!root.classList.contains('msn-sheet-open')));

  // The launcher's job ends in the transfer orbit; the rest of Chandrayaan-3 is on the Moon page.
  // Shown only for Chandrayaan-3 (see syncMission below).
  const moonBtn = el('button', 'sfb-btn msn-moon-btn sfb-hidden', 'Continue to the Moon');
  moonBtn.type = 'button';
  moonBtn.title = 'Follow Chandrayaan-3 from this orbit to the lunar surface';
  moonBtn.addEventListener('click', () => window.location.assign('./landing.html'));

  headerRight.append(missionSelect, caseSelect, flyBtn, moonBtn, sheetBtn);
  header.append(headerLeft, caseNote, headerRight);

  // ---------- Left column: Telemetry + Timeline ----------
  const colLeft = el('div', 'msn-col-left');

  const telemPanel = el('section', 'sfb-panel msn-telem-panel');
  telemPanel.append(el('h3', 'sfb-section-title', 'Telemetry'));
  const telemGrid = el('div', 'msn-telem-grid');

  const statDefs = [
    ['t', 'Time'],
    ['alt', 'Altitude'],
    ['spd', 'Speed'],
    ['mach', 'Mach'],
    ['q', 'Dyn Press'],
    ['g', 'Accel'],
    ['mass', 'Mass'],
    ['thrust', 'Thrust'],
    ['twr', 'TWR'],
    ['down', 'Downrange'],
    ['apo', 'Apoapsis'],
    ['peri', 'Periapsis'],
    ['phase', 'Phase'],
  ] as const;

  const statEls: Record<string, HTMLElement> = {};
  for (const [key, label] of statDefs) {
    const box = el('div', 'msn-stat');
    box.append(el('span', 'msn-stat-label', label));
    const val = el('span', 'msn-stat-val', '—');
    statEls[key] = val;
    box.append(val);
    telemGrid.append(box);
  }
  const propList = el('div', 'msn-prop-list');
  telemPanel.append(telemGrid, propList);

  const timelinePanel = el('section', 'sfb-panel msn-timeline-panel');
  timelinePanel.append(el('h3', 'sfb-section-title', 'Timeline'));
  const timelineList = el('div', 'msn-timeline-list');
  const flawList = el('div', 'msn-timeline-list');
  timelinePanel.append(timelineList, flawList);

  colLeft.append(telemPanel, timelinePanel);

  // ---------- Right column: Health + Active Faults ----------
  const colRight = el('div', 'msn-col-right');
  const healthPanel = el('section', 'sfb-panel msn-health-panel');
  healthPanel.append(el('h3', 'sfb-section-title', 'Vehicle Health'));
  const healthList = el('div', 'msn-health-list');
  const faultsList = el('div', 'msn-faults-list');
  healthPanel.append(healthList, faultsList);
  colRight.append(healthPanel);

  // ---------- Outcome Banner ----------
  const outcomeBanner = el('div', 'sfb-panel msn-outcome sfb-hidden');
  const outcomeBadge = el('div', 'msn-outcome-badge', '');
  const outcomeSummary = el('div', 'msn-outcome-summary', '');
  const outcomeOrbit = el('div', 'msn-outcome-orbit', '');
  outcomeBanner.append(outcomeBadge, outcomeSummary, outcomeOrbit);

  // ---------- Transport ----------
  const transport = el('footer', 'sfb-panel msn-transport');
  const playBtn = el('button', 'sfb-btn', 'Pause');
  playBtn.type = 'button';
  playBtn.addEventListener('click', () => callbacks.onPlayPause());

  const warpGroup = el('div', 'msn-btn-group');
  const warpBtns = new Map<number, HTMLButtonElement>();
  for (const w of WARPS) {
    const b = el('button', 'sfb-btn', `${w}x`);
    b.type = 'button';
    b.addEventListener('click', () => callbacks.onWarp(w));
    warpBtns.set(w, b);
    warpGroup.append(b);
  }

  const scrubber = el('input', 'msn-scrubber');
  scrubber.type = 'range';
  scrubber.min = '0';
  scrubber.max = '100';
  scrubber.step = 'any';
  scrubber.value = '0';
  scrubber.setAttribute('aria-label', 'Mission time');
  scrubber.addEventListener('input', () => {
    // The thumb moved under the user's hand: the cached value no longer matches the DOM.
    lastScrub = null;
    callbacks.onScrub(Number(scrubber.value));
  });

  const camGroup = el('div', 'msn-btn-group');
  const camBtns = new Map<MissionCameraMode, HTMLButtonElement>();
  let activeCam: MissionCameraMode = 'chase';
  for (const c of CAMERAS) {
    const b = el('button', 'sfb-btn', c.label);
    b.type = 'button';
    b.title = c.hint;
    b.addEventListener('click', () => selectCam(c.mode));
    camBtns.set(c.mode, b);
    camGroup.append(b);
  }
  camBtns.get('chase')?.classList.add('msn-btn-active');
  function selectCam(mode: MissionCameraMode): void {
    activeCam = mode;
    for (const [m, btn] of camBtns) btn.classList.toggle('msn-btn-active', m === activeCam);
    callbacks.onCamera(mode);
  }
  // Number keys 1-5 pick a preset while the mission view is open.
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (idx < 0 || root.classList.contains('sfb-hidden')) return;
    if (isTypingTarget(e.target)) return;
    selectCam(CAMERAS[idx].mode);
  });
  const scaleEl = el('span', 'msn-scale', '');
  scaleEl.title = 'Camera distance. Scroll or pinch to zoom from the pad out to the planets.';
  let lastScale = '';

  const iipEl = el('span', 'msn-iip sfb-hidden', '');

  // Clears the side panels off the view so the rocket has the whole screen. Also on H.
  const panelsBtn = el('button', 'sfb-btn msn-panels-toggle', 'Hide panels');
  panelsBtn.type = 'button';
  panelsBtn.title = 'H';
  panelsBtn.setAttribute('aria-pressed', 'false');
  // Each side also closes on its own, from a handle that stays on screen while its panel is away.
  type Side = 'left' | 'right' | 'bottom';
  const sides: Record<Side, { name: string; open: string; closed: string }> = {
    left: { name: 'telemetry and timeline', open: '‹', closed: '›' },
    right: { name: 'vehicle health', open: '›', closed: '‹' },
    bottom: { name: 'playback bar', open: '▾', closed: '▴' },
  };
  const handles = {} as Record<Side, HTMLButtonElement>;
  const isOff = (side: Side): boolean => root.classList.contains(`msn-${side}-off`);
  const setSide = (side: Side, off: boolean): void => {
    root.classList.toggle(`msn-${side}-off`, off);
    const handle = handles[side];
    const label = `${off ? 'Show' : 'Hide'} ${sides[side].name}`;
    handle.textContent = off ? sides[side].closed : sides[side].open;
    handle.title = label;
    handle.setAttribute('aria-label', label);
    handle.setAttribute('aria-expanded', String(!off));
    // With both sides away the outcome card leaves too, so the rocket has the whole view.
    const sidesOff = isOff('left') && isOff('right');
    root.classList.toggle('msn-panels-off', sidesOff);
    panelsBtn.textContent = sidesOff ? 'Show panels' : 'Hide panels';
    panelsBtn.setAttribute('aria-pressed', String(sidesOff));
  };
  for (const side of ['left', 'right', 'bottom'] as const) {
    const handle = el('button', `sfb-btn msn-handle msn-handle-${side}`);
    handle.type = 'button';
    handle.addEventListener('click', () => setSide(side, !isOff(side)));
    handles[side] = handle;
  }
  for (const side of ['left', 'right', 'bottom'] as const) setSide(side, false);

  const togglePanels = (): void => {
    const off = !(isOff('left') && isOff('right'));
    setSide('left', off);
    setSide('right', off);
  };
  panelsBtn.addEventListener('click', togglePanels);
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'h' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (root.classList.contains('sfb-hidden')) return;
    if (isTypingTarget(e.target)) return;
    togglePanels();
  });
  transport.append(playBtn, warpGroup, scrubber, camGroup, scaleEl, panelsBtn, iipEl, handles.bottom);

  // ---------- Busy overlay ----------
  const busyOverlay = el('div', 'msn-busy sfb-hidden');
  const busyCard = el('div', 'sfb-panel msn-busy-card', 'Computing flight…');
  busyOverlay.append(busyCard);

  const errorBanner = el('div', 'sfb-panel msn-error sfb-hidden');

  root.append(
    header,
    colLeft,
    handles.left,
    outcomeBanner,
    handles.right,
    colRight,
    transport,
    errorBanner,
    busyOverlay,
  );
  container.append(root);

  // ---------- State per record ----------
  let currentRecord: FlightRecord | null = null;
  let initialPropellant: number[] = [];
  let stageNames: string[] = [];
  let propBars: { fill: HTMLElement; val: HTMLElement }[] = [];
  let eventRows: { marker: FlightMarker; row: HTMLButtonElement }[] = [];
  let healthRows = new Map<string, { row: HTMLElement; fill: HTMLElement; val: HTMLElement; level: string }>();
  const caseNotes = new Map<string, string>();

  // ---------- Per-tick write caches ----------
  // update() runs ~10x a second. These remember the last value written to each node so the DOM is
  // only touched when the formatted value actually changes. resetTickCaches() forgets them whenever
  // something outside update() rewrites the same nodes (setRecord, mission change, scrubber drag).
  const lastText = new Map<Node, string>();
  const lastWidth = new Map<HTMLElement, string>();
  const lastClass = new Map<HTMLElement, Map<string, boolean>>();
  let lastActiveIdx = -1;
  let lastWarp: number | null = null;
  let lastScrub: string | null = null;
  let lastFaultKey = '';

  function setText(node: Node, value: string): void {
    if (lastText.get(node) === value) return;
    lastText.set(node, value);
    node.textContent = value;
  }

  function setWidth(node: HTMLElement, value: string): void {
    if (lastWidth.get(node) === value) return;
    lastWidth.set(node, value);
    node.style.width = value;
  }

  function setClass(node: HTMLElement, cls: string, on: boolean): void {
    let classes = lastClass.get(node);
    if (!classes) {
      classes = new Map();
      lastClass.set(node, classes);
    }
    if (classes.get(cls) === on) return;
    classes.set(cls, on);
    node.classList.toggle(cls, on);
  }

  function resetTickCaches(): void {
    lastText.clear();
    lastWidth.clear();
    lastClass.clear();
    lastWarp = null;
    lastScrub = null;
  }

  /** Identity of the rendered fault cards: ordered ids plus every field drawn into a card. */
  function faultKey(faults: FlightSnapshot['activeFaults']): string {
    let key = '';
    for (const f of faults) {
      key += `${f.id}\u0001${f.severity}\u0001${f.title}\u0001${f.detail}\u0001${f.fix}\u0002`;
    }
    return key;
  }

  caseSelect.addEventListener('change', () => {
    caseNote.textContent = caseNotes.get(caseSelect.value) ?? '';
  });

  // Picking a mission in the header: show its name and cases now; setRecord() follows with the flight.
  missionSelect.addEventListener('change', () => {
    const def = getMission(missionSelect.value);
    if (def) syncMission(def, 'nominal');
    outcomeBanner.classList.add('sfb-hidden');
    resetTickCaches();
    callbacks.onMission(missionSelect.value);
  });

  /** Keeps the mission picker, title, Moon button and case list in step with `def`. */
  function syncMission(def: MissionDef, selectedCase: string): void {
    missionSelect.value = def.id;
    vehicleTitle.textContent = def.name;
    moonBtn.classList.toggle('sfb-hidden', def.id !== 'lvm3-m4');
    populateCases(def, selectedCase);
  }

  function populateCases(def: MissionDef, selected: string): void {
    caseSelect.textContent = '';
    caseNotes.clear();

    const nomOpt = el('option', undefined, 'Nominal');
    nomOpt.value = 'nominal';
    caseSelect.append(nomOpt);
    caseNotes.set('nominal', def.description);

    for (const fc of def.failureCases ?? []) {
      const opt = el('option', undefined, `${fc.id} — ${fc.note}`);
      opt.value = fc.id;
      caseSelect.append(opt);
      caseNotes.set(fc.id, fc.note);
    }

    // The pressure and thermal scenarios act on a mission's fault model. Without one they would
    // fly an ordinary flight under a misleading name, so they are only offered when it exists.
    for (const sc of def.faults ? SCENARIOS : []) {
      const opt = el('option', undefined, `${sc.label} — ${sc.note}`);
      opt.value = sc.id;
      caseSelect.append(opt);
      caseNotes.set(sc.id, sc.note);
    }

    const value = caseNotes.has(selected) ? selected : 'nominal';
    caseSelect.value = value;
    caseNote.textContent = caseNotes.get(value) ?? '';
  }

  function buildPropellantBars(record: FlightRecord, def: MissionDef): void {
    propList.textContent = '';
    propBars = [];
    const vehicle = def.vehicle();
    stageNames = vehicle.stages.map((s) => s.name);
    const p0 = record.samples[0]?.propellant ?? [];
    initialPropellant = p0.slice();

    for (let i = 0; i < p0.length; i++) {
      const row = el('div', 'msn-bar-row');
      const head = el('div', 'msn-bar-head');
      head.append(el('span', undefined, stageNames[i] ?? `Stage ${i + 1}`));
      const val = el('span', undefined, '100%');
      head.append(val);
      const track = el('div', 'msn-bar-track');
      const fill = el('div', 'msn-bar-fill');
      fill.style.width = '100%';
      track.append(fill);
      row.append(head, track);
      propList.append(row);
      propBars.push({ fill, val });
    }
  }

  function buildTimeline(record: FlightRecord): void {
    timelineList.textContent = '';
    flawList.textContent = '';
    eventRows = [];
    lastActiveIdx = -1; // fresh rows carry no highlight

    for (const m of record.markers) {
      if (m.kind === 'event') {
        const row = el('button', 'msn-event-row');
        row.type = 'button';
        const top = el('div', 'msn-event-top');
        top.append(el('span', undefined, m.label));
        const times = el('div', 'msn-event-times');
        times.append(el('span', undefined, formatMissionTime(m.t)));
        if (m.reference !== undefined) {
          const diff = m.t - m.reference;
          const sign = diff >= 0 ? '+' : '';
          times.append(el('span', undefined, `Ref ${m.reference.toFixed(1)} s (${sign}${diff.toFixed(1)} s)`));
        }
        row.append(top, times);
        row.addEventListener('click', () => callbacks.onScrub(m.t));
        timelineList.append(row);
        eventRows.push({ marker: m, row });
      } else {
        const sev = m.severity ?? 'info';
        const flaw = el('div', `msn-flaw-row msn-sev-${sev}`, `${formatMissionTime(m.t)} · ${m.label}`);
        flawList.append(flaw);
      }
    }
  }

  function ensureHealthRow(key: string): { row: HTMLElement; fill: HTMLElement; val: HTMLElement; level: string } {
    const existing = healthRows.get(key);
    if (existing) return existing;
    const row = el('div', 'msn-bar-row msn-health-good');
    const head = el('div', 'msn-bar-head');
    head.append(el('span', undefined, HEALTH_LABELS[key] ?? key));
    const val = el('span', 'msn-health-val', '0.00');
    head.append(val);
    const track = el('div', 'msn-bar-track');
    const fill = el('div', 'msn-bar-fill');
    track.append(fill);
    row.append(head, track);
    healthList.append(row);
    const entry = { row, fill, val, level: 'msn-health-good' };
    healthRows.set(key, entry);
    return entry;
  }

  function setRecord(record: FlightRecord, def: MissionDef): void {
    currentRecord = record;
    syncMission(def, record.failureCase ?? record.scenario ?? 'nominal');
    buildPropellantBars(record, def);
    buildTimeline(record);

    healthList.textContent = '';
    healthRows.clear();
    faultsList.textContent = '';
    lastFaultKey = '';
    resetTickCaches();

    const firstHealth = record.samples[0]?.health;
    if (firstHealth) {
      for (const key of Object.keys(firstHealth)) {
        ensureHealthRow(key);
      }
    }

    const firstT = record.samples[0]?.t ?? 0;
    const lastT = record.samples[record.samples.length - 1]?.t ?? 100;
    scrubber.min = String(firstT);
    scrubber.max = String(lastT);
    scrubber.value = String(firstT);
    outcomeBanner.classList.add('sfb-hidden');
  }

  function update(snapshot: FlightSnapshot, playing: boolean, warp: number): void {
    setText(statEls.t, formatMissionTime(snapshot.t));
    setText(statEls.alt, fmtAlt(snapshot.altitude));
    setText(statEls.spd, fmtSpeed(snapshot.speed));
    setText(statEls.mach, snapshot.mach.toFixed(2));
    setText(
      statEls.q,
      snapshot.q >= 1000 ? `${(snapshot.q / 1000).toFixed(1)} kPa` : `${Math.round(snapshot.q)} Pa`,
    );
    setText(statEls.g, `${snapshot.accelG.toFixed(2)} g`);
    setText(
      statEls.mass,
      snapshot.mass >= 1000 ? `${(snapshot.mass / 1000).toFixed(1)} t` : `${Math.round(snapshot.mass)} kg`,
    );
    setText(statEls.thrust, formatThrust(snapshot.thrust));
    setText(statEls.twr, thrustToWeight(snapshot).toFixed(2));
    setText(statEls.down, snapshot.downrange !== undefined ? fmtAlt(snapshot.downrange) : '—');
    setText(statEls.apo, snapshot.apoapsis !== undefined ? fmtAlt(snapshot.apoapsis) : '—');
    setText(statEls.peri, snapshot.periapsis !== undefined ? fmtAlt(snapshot.periapsis) : '—');
    setText(statEls.phase, snapshot.phase ? phaseLabel(snapshot.phase) : '—');

    // Propellant bars
    const props = snapshot.propellant ?? [];
    for (let i = 0; i < propBars.length; i++) {
      const full = initialPropellant[i] ?? 0;
      const rem = props[i] ?? 0;
      const pct = full > 0 ? Math.max(0, Math.min(100, (rem / full) * 100)) : 0;
      setWidth(propBars[i].fill, `${pct.toFixed(1)}%`);
      setText(propBars[i].val, `${Math.round(pct)}%`);
    }

    // Highlight latest event at or before t; only the rows that change state are touched.
    let activeIdx = -1;
    for (let i = 0; i < eventRows.length; i++) {
      if (eventRows[i].marker.t <= snapshot.t + 1e-6) {
        activeIdx = i;
      }
    }
    if (activeIdx !== lastActiveIdx) {
      eventRows[lastActiveIdx]?.row.classList.remove('msn-event-active');
      eventRows[activeIdx]?.row.classList.add('msn-event-active');
      lastActiveIdx = activeIdx;
    }

    // Health bars
    if (snapshot.health) {
      for (const [key, value] of Object.entries(snapshot.health)) {
        const entry = ensureHealthRow(key);
        setText(entry.val, value.toFixed(2));
        setWidth(entry.fill, `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`);
        const level =
          value > 1.0 ? 'msn-health-critical' : value >= 0.8 ? 'msn-health-warning' : 'msn-health-good';
        if (level !== entry.level) {
          entry.row.classList.remove(entry.level);
          entry.row.classList.add(level);
          entry.level = level;
        }
      }
    }

    // Active faults: the cards are rebuilt only when the set of faults (or their text) changes.
    // Every field drawn into a card is fixed per fault, so there is no live text to refresh.
    const key = faultKey(snapshot.activeFaults);
    if (key !== lastFaultKey) {
      lastFaultKey = key;
      faultsList.textContent = '';
      for (const f of snapshot.activeFaults) {
        const card = el('div', `msn-fault-card msn-sev-${f.severity}`);
        card.append(
          el('div', 'msn-fault-title', f.title),
          el('div', 'msn-fault-detail', f.detail),
          el('div', 'msn-fault-fix', f.fix),
        );
        faultsList.append(card);
      }
    }

    // Transport
    setText(playBtn, playing ? 'Pause' : 'Play');
    if (warp !== lastWarp) {
      for (const [w, b] of warpBtns) {
        b.classList.toggle('msn-btn-active', w === warp);
      }
      lastWarp = warp;
    }
    const scrubValue = String(snapshot.t);
    if (scrubValue !== lastScrub) {
      scrubber.value = scrubValue;
      lastScrub = scrubValue;
    }

    if (snapshot.iip) {
      setText(iipEl, `IIP ${fmtLatLon(snapshot.iip.latDeg, snapshot.iip.lonDeg)}`);
      setClass(iipEl, 'sfb-hidden', false);
    } else {
      setClass(iipEl, 'sfb-hidden', true);
    }

    // Outcome banner at end
    const lastT = currentRecord?.samples[currentRecord.samples.length - 1]?.t ?? Infinity;
    const outcome = currentRecord?.outcome;
    if (outcome && snapshot.t >= lastT - 1e-6) {
      setText(outcomeBadge, outcome.outcome.toUpperCase());
      setText(outcomeSummary, outcome.summary);
      setText(
        outcomeOrbit,
        `${(outcome.perigeeAltitude / 1000).toFixed(1)} x ${(outcome.apogeeAltitude / 1000).toFixed(1)} km`,
      );
      setClass(outcomeBanner, 'sfb-hidden', false);
    } else {
      setClass(outcomeBanner, 'sfb-hidden', true);
    }
  }

  return {
    setVisible(on: boolean) {
      root.classList.toggle('sfb-hidden', !on);
      if (!on) setSheet(false);
    },
    setBusy(text: string | null) {
      if (text === null) {
        busyOverlay.classList.add('sfb-hidden');
      } else {
        busyCard.textContent = text;
        busyOverlay.classList.remove('sfb-hidden');
      }
    },
    setError(msg: string | null) {
      if (msg === null) {
        errorBanner.classList.add('sfb-hidden');
      } else {
        errorBanner.textContent = msg;
        errorBanner.classList.remove('sfb-hidden');
      }
    },
    setRecord,
    update,
    setViewScale(m: number) {
      const text = formatViewDistance(m);
      if (text !== lastScale) {
        lastScale = text;
        scaleEl.textContent = text;
      }
    },
  };
}
