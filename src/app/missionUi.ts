import './style.css';
import './mission.css';
import type { FlightMarker, FlightRecord } from '../mission/record';
import type { FlightSnapshot } from '../mission/snapshot';
import type { MissionDef } from '../mission/vehicles';
import type { MissionCameraMode } from './missionView';

export interface MissionUiCallbacks {
  onExit(): void;
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
const CAMERAS: { mode: MissionCameraMode; label: string }[] = [
  { mode: 'chase', label: 'Chase' },
  { mode: 'pad', label: 'Pad' },
  { mode: 'map', label: 'Map' },
];

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

function fmtSpeed(mps: number): string {
  return Math.abs(mps) >= 1000 ? `${(mps / 1000).toFixed(2)} km/s` : `${Math.round(mps)} m/s`;
}

function fmtLatLon(latDeg: number, lonDeg: number): string {
  const ns = latDeg >= 0 ? 'N' : 'S';
  const ew = lonDeg >= 0 ? 'E' : 'W';
  return `${Math.abs(latDeg).toFixed(2)}°${ns}, ${Math.abs(lonDeg).toFixed(2)}°${ew}`;
}

export function createMissionUI(container: HTMLElement, callbacks: MissionUiCallbacks): MissionUi {
  const root = el('div', 'sfb-root msn-root sfb-hidden');

  // ---------- Header ----------
  const header = el('header', 'sfb-panel msn-header');
  const headerLeft = el('div', 'msn-header-left');
  const backBtn = el('button', 'sfb-btn', 'Back');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => callbacks.onExit());
  const vehicleTitle = el('h2', 'msn-vehicle-name', 'LVM3-M4');
  headerLeft.append(backBtn, vehicleTitle);

  const headerRight = el('div', 'msn-header-right');
  const caseSelect = el('select', 'msn-select');
  caseSelect.setAttribute('aria-label', 'Flight case');
  const caseNote = el('span', 'msn-case-note', '');
  const flyBtn = el('button', 'sfb-btn sfb-btn-primary', 'Fly');
  flyBtn.type = 'button';
  flyBtn.addEventListener('click', () => callbacks.onFly(caseSelect.value || 'nominal'));

  const sheetBtn = el('button', 'sfb-btn msn-sheet-toggle', 'Timeline & Health');
  sheetBtn.type = 'button';
  sheetBtn.addEventListener('click', () => {
    root.classList.toggle('msn-sheet-open');
  });

  headerRight.append(caseSelect, flyBtn, sheetBtn);
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
  scrubber.step = '0.1';
  scrubber.value = '0';
  scrubber.setAttribute('aria-label', 'Mission time');
  scrubber.addEventListener('input', () => callbacks.onScrub(Number(scrubber.value)));

  const camGroup = el('div', 'msn-btn-group');
  const camBtns = new Map<MissionCameraMode, HTMLButtonElement>();
  let activeCam: MissionCameraMode = 'chase';
  for (const c of CAMERAS) {
    const b = el('button', 'sfb-btn', c.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      activeCam = c.mode;
      for (const [m, btn] of camBtns) btn.classList.toggle('msn-btn-active', m === activeCam);
      callbacks.onCamera(c.mode);
    });
    camBtns.set(c.mode, b);
    camGroup.append(b);
  }
  camBtns.get('chase')?.classList.add('msn-btn-active');

  const iipEl = el('span', 'msn-iip sfb-hidden', '');
  transport.append(playBtn, warpGroup, scrubber, camGroup, iipEl);

  // ---------- Busy overlay ----------
  const busyOverlay = el('div', 'msn-busy sfb-hidden');
  const busyCard = el('div', 'sfb-panel msn-busy-card', 'Computing flight…');
  busyOverlay.append(busyCard);

  const errorBanner = el('div', 'sfb-panel msn-error sfb-hidden');

  root.append(header, colLeft, outcomeBanner, colRight, transport, errorBanner, busyOverlay);
  container.append(root);

  // ---------- State per record ----------
  let currentRecord: FlightRecord | null = null;
  let initialPropellant: number[] = [];
  let stageNames: string[] = [];
  let propBars: { fill: HTMLElement; val: HTMLElement }[] = [];
  let eventRows: { marker: FlightMarker; row: HTMLButtonElement }[] = [];
  let healthRows = new Map<string, { row: HTMLElement; fill: HTMLElement; val: HTMLElement }>();
  const caseNotes = new Map<string, string>();

  caseSelect.addEventListener('change', () => {
    caseNote.textContent = caseNotes.get(caseSelect.value) ?? '';
  });

  function populatePicker(def: MissionDef, record: FlightRecord): void {
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

    for (const sc of SCENARIOS) {
      const opt = el('option', undefined, `${sc.label} — ${sc.note}`);
      opt.value = sc.id;
      caseSelect.append(opt);
      caseNotes.set(sc.id, sc.note);
    }

    const selected = record.failureCase ?? record.scenario ?? 'nominal';
    caseSelect.value = selected;
    caseNote.textContent = caseNotes.get(selected) ?? '';
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

    for (const m of record.markers) {
      if (m.kind === 'event') {
        const row = el('button', 'msn-event-row');
        row.type = 'button';
        const top = el('div', 'msn-event-top');
        top.append(el('span', undefined, m.label));
        const times = el('div', 'msn-event-times');
        times.append(el('span', undefined, `T+${m.t.toFixed(1)} s`));
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
        const flaw = el('div', `msn-flaw-row msn-sev-${sev}`, `T+${m.t.toFixed(1)} s · ${m.label}`);
        flawList.append(flaw);
      }
    }
  }

  function ensureHealthRow(key: string): { row: HTMLElement; fill: HTMLElement; val: HTMLElement } {
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
    const entry = { row, fill, val };
    healthRows.set(key, entry);
    return entry;
  }

  function setRecord(record: FlightRecord, def: MissionDef): void {
    currentRecord = record;
    vehicleTitle.textContent = record.vehicleName ?? def.name;
    populatePicker(def, record);
    buildPropellantBars(record, def);
    buildTimeline(record);

    healthList.textContent = '';
    healthRows.clear();
    faultsList.textContent = '';

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
    statEls.t.textContent = `T+${snapshot.t.toFixed(1)} s`;
    statEls.alt.textContent = fmtAlt(snapshot.altitude);
    statEls.spd.textContent = fmtSpeed(snapshot.speed);
    statEls.mach.textContent = snapshot.mach.toFixed(2);
    statEls.q.textContent =
      snapshot.q >= 1000 ? `${(snapshot.q / 1000).toFixed(1)} kPa` : `${Math.round(snapshot.q)} Pa`;
    statEls.g.textContent = `${snapshot.accelG.toFixed(2)} g`;
    statEls.mass.textContent =
      snapshot.mass >= 1000 ? `${(snapshot.mass / 1000).toFixed(1)} t` : `${Math.round(snapshot.mass)} kg`;
    statEls.down.textContent =
      snapshot.downrange !== undefined ? fmtAlt(snapshot.downrange) : '—';
    statEls.apo.textContent =
      snapshot.apoapsis !== undefined ? fmtAlt(snapshot.apoapsis) : '—';
    statEls.peri.textContent =
      snapshot.periapsis !== undefined ? fmtAlt(snapshot.periapsis) : '—';
    statEls.phase.textContent = snapshot.phase ?? '—';

    // Propellant bars
    const props = snapshot.propellant ?? [];
    for (let i = 0; i < propBars.length; i++) {
      const full = initialPropellant[i] ?? 0;
      const rem = props[i] ?? 0;
      const pct = full > 0 ? Math.max(0, Math.min(100, (rem / full) * 100)) : 0;
      propBars[i].fill.style.width = `${pct.toFixed(1)}%`;
      propBars[i].val.textContent = `${Math.round(pct)}%`;
    }

    // Highlight latest event at or before t
    let activeIdx = -1;
    for (let i = 0; i < eventRows.length; i++) {
      if (eventRows[i].marker.t <= snapshot.t + 1e-6) {
        activeIdx = i;
      }
    }
    for (let i = 0; i < eventRows.length; i++) {
      eventRows[i].row.classList.toggle('msn-event-active', i === activeIdx);
    }

    // Health bars
    if (snapshot.health) {
      for (const [key, value] of Object.entries(snapshot.health)) {
        const entry = ensureHealthRow(key);
        entry.val.textContent = value.toFixed(2);
        entry.fill.style.width = `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`;
        entry.row.classList.remove('msn-health-good', 'msn-health-warning', 'msn-health-critical');
        if (value > 1.0) entry.row.classList.add('msn-health-critical');
        else if (value >= 0.8) entry.row.classList.add('msn-health-warning');
        else entry.row.classList.add('msn-health-good');
      }
    }

    // Active faults
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

    // Transport
    playBtn.textContent = playing ? 'Pause' : 'Play';
    for (const [w, b] of warpBtns) {
      b.classList.toggle('msn-btn-active', w === warp);
    }
    scrubber.value = String(snapshot.t);

    if (snapshot.iip) {
      iipEl.textContent = `IIP ${fmtLatLon(snapshot.iip.latDeg, snapshot.iip.lonDeg)}`;
      iipEl.classList.remove('sfb-hidden');
    } else {
      iipEl.classList.add('sfb-hidden');
    }

    // Outcome banner at end
    const lastT = currentRecord?.samples[currentRecord.samples.length - 1]?.t ?? Infinity;
    const outcome = currentRecord?.outcome;
    if (outcome && snapshot.t >= lastT - 1e-6) {
      outcomeBadge.textContent = outcome.outcome.toUpperCase();
      outcomeSummary.textContent = outcome.summary;
      outcomeOrbit.textContent = `${(outcome.perigeeAltitude / 1000).toFixed(1)} x ${(outcome.apogeeAltitude / 1000).toFixed(1)} km`;
      outcomeBanner.classList.remove('sfb-hidden');
    } else {
      outcomeBanner.classList.add('sfb-hidden');
    }
  }

  return {
    setVisible(on: boolean) {
      root.classList.toggle('sfb-hidden', !on);
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
  };
}
