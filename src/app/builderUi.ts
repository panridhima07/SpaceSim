// DOM UI for Build Mode: parts palette, snap banner, rocket stack, live part
// inspector (sliders + number boxes), undo/redo, and Go to Pad.
// Works in both desktop layout and .sfb-mobile phone layout (44px+ touch targets).

import {
  findPart,
  mapFlawsToParts,
  type Design,
  type PartPatch,
} from '../builder/design';
import {
  CATEGORY_LABELS,
  MATERIALS,
  PART_CATEGORIES,
  PART_PRESETS,
  type AnchorMode,
  type PartCategory,
  type PartPreset,
} from '../builder/parts';
import type { SnapPoint } from '../builder/snap';
import type { SavedDesign } from '../builder/storage';
import { CHALLENGES } from '../builder/challenges';
import type {
  BodyTube,
  Component,
  FinSet,
  Flaw,
  InnerTube,
  MassComponent,
  Motor,
  NoseCone,
  NoseShape,
  Parachute,
  Ring,
  Transition,
} from '../types';

export interface BuilderStats {
  length: number;
  mass: number;
  stabilityCal: number;
  twr: number | null;
  motorLabel: string | null;
  flaws: Flaw[];
}

export interface TransitionPrompt {
  preset: PartPreset;
  snap: SnapPoint;
}

export interface BuilderUICallbacks {
  onStartPlace(preset: PartPreset): void;
  onCancelPlace(): void;
  onChooseSnap(snap: SnapPoint, addTransition?: boolean): void;
  onDragStartPreset(preset: PartPreset): void;
  onDragEndPreset(): void;
  onSelectPart(partId: string | null): void;
  onUpdatePart(partId: string, patch: PartPatch, commit: boolean): void;
  onMovePart(partId: string, delta: number): void;
  onDuplicatePart(partId: string): void;
  onDeletePart(partId: string): void;
  onUndo(): void;
  onRedo(): void;
  onRename(name: string): void;
  onClear(): void;
  onToggleCutaway(on: boolean): void;
  onFrameCamera(): void;
  onGoToPad(): void;
  onMission?(): void;
  onSaveDesign(): void;
  onLoadSavedDesign(design: Design): void;
  onDeleteSavedDesign(id: string): void;
  onExportJson(): void;
  onExportOrk(): void;
  onImportFile(file: File): void;
}

export interface BuilderRenderState {
  design: Design;
  selectedId: string | null;
  stats: BuilderStats;
  canUndo: boolean;
  canRedo: boolean;
  motors: Motor[];
  savedDesigns: SavedDesign[];
  completedChallenges: Set<string>;
  /** Pass true when design changed externally (undo/redo/load) so inspector inputs refresh. */
  forceInspectorRefresh?: boolean;
}

export interface BuilderUI {
  readonly root: HTMLElement;
  setVisible(visible: boolean): void;
  render(state: BuilderRenderState): void;
  setPlacing(preset: PartPreset | null, snaps: SnapPoint[]): void;
  setTransitionPrompt(prompt: TransitionPrompt | null): void;
  setCutaway(on: boolean): void;
}

const MOBILE_QUERY = '(max-width: 760px), (max-height: 500px)';
const NOSE_SHAPES: readonly NoseShape[] = ['ogive', 'conical', 'ellipsoid', 'parabolic', 'power', 'haack'];
const TUTORIAL_KEY = 'sfb.builder.tutorial.v1';
const PART_SWATCHES: readonly { label: string; hex: number }[] = [
  { label: 'White', hex: 0xf2f1ec },
  { label: 'Rocket Red', hex: 0xe2552f },
  { label: 'Astra Blue', hex: 0x4da3ff },
  { label: 'Slate', hex: 0x2b3440 },
  { label: 'Gold', hex: 0xd9a426 },
  { label: 'Orange', hex: 0xf07a2a },
  { label: 'Emerald', hex: 0x2eb872 },
  { label: 'Carbon', hex: 0x181c22 },
];

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

function stabilityClass(cal: number): string {
  if (!Number.isFinite(cal)) return '';
  if (cal < 1) return 'sfb-stab-critical';
  if ((cal >= 1 && cal <= 1.5) || cal > 3) return 'sfb-stab-warning';
  return 'sfb-stab-good';
}

function motorKey(m: Motor): string {
  return `${m.manufacturer} ${m.designation}`.trim();
}

function nearestMaterialDensity(density: number): string {
  let best = MATERIALS[0];
  let bestDiff = Infinity;
  for (const m of MATERIALS) {
    const d = Math.abs(m.density - density);
    if (d < bestDiff) {
      bestDiff = d;
      best = m;
    }
  }
  return bestDiff <= 25 ? String(best.density) : 'custom';
}

export function createBuilderUI(container: HTMLElement, cb: BuilderUICallbacks): BuilderUI {
  const root = h('div', 'sfb-root sfb-builder sfb-hidden');

  // ===== Top bar: name, live engineering stats, undo/redo, Go to pad =====
  const topBar = h('header', 'sfb-panel sfb-b-top');

  const nameInput = h('input', 'sfb-input sfb-b-name');
  nameInput.type = 'text';
  nameInput.value = 'New Rocket';
  nameInput.setAttribute('aria-label', 'Rocket name');
  nameInput.addEventListener('change', () => cb.onRename(nameInput.value.trim() || 'New Rocket'));

  const statsEl = h('div', 'sfb-b-stats');
  const makeStat = (label: string): { el: HTMLElement; val: HTMLElement } => {
    const wrap = h('div', 'sfb-b-stat');
    const val = h('span', 'sfb-b-stat-v', '—');
    wrap.append(h('span', 'sfb-b-stat-k', label), val);
    statsEl.append(wrap);
    return { el: wrap, val };
  };
  const sLen = makeStat('LEN');
  const sMass = makeStat('MASS');
  const sStab = makeStat('STAB');
  const sTwr = makeStat('TWR');

  const topActions = h('div', 'sfb-b-top-actions');

  const undoBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Undo');
  undoBtn.type = 'button';
  undoBtn.title = 'Undo (Ctrl+Z)';
  undoBtn.addEventListener('click', () => cb.onUndo());

  const redoBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Redo');
  redoBtn.type = 'button';
  redoBtn.title = 'Redo (Ctrl+Y)';
  redoBtn.addEventListener('click', () => cb.onRedo());

  let cutawayOn = false;
  const cutawayBtn = h('button', 'sfb-btn', 'Cutaway');
  cutawayBtn.type = 'button';
  cutawayBtn.addEventListener('click', () => {
    cutawayOn = !cutawayOn;
    cutawayBtn.classList.toggle('is-active', cutawayOn);
    mCutawayBtn.classList.toggle('is-active', cutawayOn);
    cb.onToggleCutaway(cutawayOn);
  });

  const fitBtn = h('button', 'sfb-btn', 'Fit');
  fitBtn.type = 'button';
  fitBtn.title = 'Frame rocket in view';
  fitBtn.addEventListener('click', () => cb.onFrameCamera());

  const filesBtn = h('button', 'sfb-btn', 'Save / Load');
  filesBtn.type = 'button';
  filesBtn.addEventListener('click', () => toggleFilesModal());

  const chalBtn = h('button', 'sfb-btn', 'Challenges');
  chalBtn.type = 'button';
  chalBtn.addEventListener('click', () => chalModal.classList.toggle('sfb-hidden'));

  const msnBtn = h('button', 'sfb-btn', 'LVM3 Mission');
  msnBtn.type = 'button';
  msnBtn.title = 'Fly the Chandrayaan-3 / LVM3-M4 mission';
  msnBtn.addEventListener('click', () => cb.onMission?.());

  const padBtn = h('button', 'sfb-btn sfb-btn-primary sfb-b-pad-btn', 'Go to Pad');
  padBtn.type = 'button';
  padBtn.addEventListener('click', () => cb.onGoToPad());

  topActions.append(undoBtn, redoBtn, cutawayBtn, fitBtn, filesBtn, chalBtn, msnBtn, padBtn);
  topBar.append(nameInput, statsEl, topActions);

  // ===== Left panel: Parts Palette =====
  const palettePanel = h('aside', 'sfb-panel sfb-b-palette');
  palettePanel.append(h('h2', 'sfb-section-title', 'Parts'));

  let activeCat: PartCategory | 'all' = 'all';
  const catBar = h('div', 'sfb-b-cats');
  const catButtons = new Map<PartCategory | 'all', HTMLButtonElement>();

  const addCatBtn = (key: PartCategory | 'all', label: string): void => {
    const btn = h('button', 'sfb-b-cat', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      activeCat = key;
      renderPalette();
    });
    catButtons.set(key, btn);
    catBar.append(btn);
  };
  addCatBtn('all', 'All');
  for (const c of PART_CATEGORIES) addCatBtn(c, CATEGORY_LABELS[c]);

  const partList = h('div', 'sfb-b-part-list');
  let activePlacingId: string | null = null;

  function renderPalette(): void {
    for (const [k, btn] of catButtons) {
      btn.classList.toggle('is-active', k === activeCat);
    }
    partList.textContent = '';
    const items = activeCat === 'all' ? PART_PRESETS : PART_PRESETS.filter((p) => p.category === activeCat);
    for (const preset of items) {
      const card = h(
        'button',
        `sfb-b-part-card${activePlacingId === preset.presetId ? ' is-placing' : ''}`,
      );
      card.type = 'button';
      card.draggable = true;
      card.dataset.presetId = preset.presetId;
      card.append(
        h('span', 'sfb-b-part-name', preset.label),
        h('span', 'sfb-b-part-sub', preset.subtitle),
      );
      card.addEventListener('click', () => {
        if (activePlacingId === preset.presetId) {
          cb.onCancelPlace();
        } else {
          setMobileDrawer('none');
          cb.onStartPlace(preset);
        }
      });
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', preset.presetId);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
        cb.onDragStartPreset(preset);
      });
      card.addEventListener('dragend', () => cb.onDragEndPreset());
      partList.append(card);
    }
  }
  renderPalette();
  palettePanel.append(catBar, partList);

  // ===== Floating snap placement / transition banner =====
  const snapBanner = h('div', 'sfb-panel sfb-b-snap-banner sfb-hidden');

  // ===== Right panel: Rocket Stack + Part Inspector + Live Flaws =====
  const rightPanel = h('aside', 'sfb-panel sfb-b-right');

  const stackHead = h('div', 'sfb-b-stack-head');
  stackHead.append(h('h2', 'sfb-section-title', 'Rocket Stack'));
  const stackHeadBtns = h('div', 'sfb-b-insp-actions');
  const mFilesBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Save/Load');
  mFilesBtn.type = 'button';
  mFilesBtn.addEventListener('click', () => toggleFilesModal());
  // The top bar's Challenges button is hidden on phones; this one sits in the Edit drawer.
  const mChalBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Challenges');
  mChalBtn.type = 'button';
  mChalBtn.addEventListener('click', () => chalModal.classList.toggle('sfb-hidden'));
  const clearBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Clear');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => cb.onClear());
  stackHeadBtns.append(mFilesBtn, mChalBtn, clearBtn);
  stackHead.append(stackHeadBtns);

  const stackList = h('ul', 'sfb-b-stack');
  const stackEmpty = h('p', 'sfb-hint', 'Tap a part in the palette to start building.');

  const inspectorWrap = h('div', 'sfb-b-inspector sfb-hidden');

  const flawsWrap = h('div', 'sfb-b-flaws sfb-hidden');

  rightPanel.append(stackHead, stackEmpty, stackList, inspectorWrap, flawsWrap);

  // ===== Mobile bottom bar =====
  const mobileBar = h('div', 'sfb-panel sfb-b-mobile-bar');
  let mobileDrawer: 'none' | 'parts' | 'stack' = 'none';

  const mPartsBtn = h('button', 'sfb-btn', 'Parts');
  mPartsBtn.type = 'button';
  const mStackBtn = h('button', 'sfb-btn', 'Edit');
  mStackBtn.type = 'button';
  const mUndoBtn = h('button', 'sfb-btn', '↶');
  mUndoBtn.type = 'button';
  mUndoBtn.setAttribute('aria-label', 'Undo');
  const mRedoBtn = h('button', 'sfb-btn', '↷');
  mRedoBtn.type = 'button';
  mRedoBtn.setAttribute('aria-label', 'Redo');
  const mCutawayBtn = h('button', 'sfb-btn', 'X-Ray');
  mCutawayBtn.type = 'button';
  const mPadBtn = h('button', 'sfb-btn sfb-btn-primary', 'Pad');
  mPadBtn.type = 'button';

  function setMobileDrawer(next: 'none' | 'parts' | 'stack'): void {
    mobileDrawer = mobileDrawer === next ? 'none' : next;
    palettePanel.classList.toggle('is-drawer-open', mobileDrawer === 'parts');
    rightPanel.classList.toggle('is-drawer-open', mobileDrawer === 'stack');
    mPartsBtn.classList.toggle('is-active', mobileDrawer === 'parts');
    mStackBtn.classList.toggle('is-active', mobileDrawer === 'stack');
  }

  mPartsBtn.addEventListener('click', () => setMobileDrawer('parts'));
  mStackBtn.addEventListener('click', () => setMobileDrawer('stack'));
  mUndoBtn.addEventListener('click', () => cb.onUndo());
  mRedoBtn.addEventListener('click', () => cb.onRedo());
  mCutawayBtn.addEventListener('click', () => {
    cutawayOn = !cutawayOn;
    cutawayBtn.classList.toggle('is-active', cutawayOn);
    mCutawayBtn.classList.toggle('is-active', cutawayOn);
    cb.onToggleCutaway(cutawayOn);
  });
  mPadBtn.addEventListener('click', () => cb.onGoToPad());

  mobileBar.append(mPartsBtn, mStackBtn, mUndoBtn, mRedoBtn, mCutawayBtn, mPadBtn);

  // ===== Save / Load / Export modal =====
  const filesModal = h('div', 'sfb-b-modal-backdrop sfb-hidden');
  const filesCard = h('section', 'sfb-panel sfb-b-modal');
  const filesHead = h('div', 'sfb-b-stack-head');
  filesHead.append(h('h2', 'sfb-section-title', 'Designs & Files'));
  const filesClose = h('button', 'sfb-btn sfb-b-mini-btn', 'Close');
  filesClose.type = 'button';
  filesClose.addEventListener('click', () => filesModal.classList.add('sfb-hidden'));
  filesHead.append(filesClose);

  const importInput = h('input', 'sfb-hidden');
  importInput.type = 'file';
  // Android's picker only lists .ork files when the generic MIME type is included too.
  importInput.accept = '.json,.ork,.xml,application/json,application/zip,application/octet-stream';
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (file) {
      filesModal.classList.add('sfb-hidden');
      cb.onImportFile(file);
    }
  });

  const fileActions = h('div', 'sfb-b-file-actions');
  const saveBtn = h('button', 'sfb-btn sfb-btn-primary', 'Save Current');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => cb.onSaveDesign());

  const expOrkBtn = h('button', 'sfb-btn', 'Export .ork');
  expOrkBtn.type = 'button';
  expOrkBtn.addEventListener('click', () => cb.onExportOrk());

  const expJsonBtn = h('button', 'sfb-btn', 'Export .json');
  expJsonBtn.type = 'button';
  expJsonBtn.addEventListener('click', () => cb.onExportJson());

  const impBtn = h('button', 'sfb-btn', 'Import .json / .ork');
  impBtn.type = 'button';
  impBtn.addEventListener('click', () => importInput.click());

  fileActions.append(saveBtn, expOrkBtn, expJsonBtn, impBtn, importInput);

  const savedGrid = h('div', 'sfb-b-saved-grid');
  const savedEmpty = h('p', 'sfb-hint', 'No saved designs yet. Click "Save Current" to store this rocket.');

  filesCard.append(filesHead, fileActions, savedEmpty, savedGrid);
  filesModal.append(filesCard);
  filesModal.addEventListener('click', (e) => {
    if (e.target === filesModal) filesModal.classList.add('sfb-hidden');
  });

  function toggleFilesModal(): void {
    filesModal.classList.toggle('sfb-hidden');
  }

  function renderSavedDesigns(list: SavedDesign[]): void {
    savedGrid.textContent = '';
    savedEmpty.classList.toggle('sfb-hidden', list.length > 0);
    for (const item of list) {
      const card = h('div', 'sfb-b-saved-card');
      if (item.thumbnail) {
        const img = h('img', 'sfb-b-saved-thumb');
        img.src = item.thumbnail;
        img.alt = item.name;
        card.append(img);
      } else {
        card.append(h('div', 'sfb-b-saved-thumb sfb-b-saved-placeholder', 'Rocket'));
      }
      const meta = h('div', 'sfb-b-saved-meta');
      meta.append(
        h('span', 'sfb-b-part-name', item.name),
        h('span', 'sfb-b-part-sub', new Date(item.savedAt).toLocaleDateString()),
      );
      const row = h('div', 'sfb-b-saved-btns');
      const openBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Open');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => {
        filesModal.classList.add('sfb-hidden');
        cb.onLoadSavedDesign(item.design);
      });
      const delBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-warn-btn', 'Del');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => cb.onDeleteSavedDesign(item.id));
      row.append(openBtn, delBtn);
      card.append(meta, row);
      savedGrid.append(card);
    }
  }

  // ===== Challenges modal =====
  const chalModal = h('div', 'sfb-b-modal-backdrop sfb-hidden');
  const chalCard = h('section', 'sfb-panel sfb-b-modal');
  const chalHead = h('div', 'sfb-b-stack-head');
  chalHead.append(h('h2', 'sfb-section-title', 'Engineering Challenges'));
  const chalClose = h('button', 'sfb-btn sfb-b-mini-btn', 'Close');
  chalClose.type = 'button';
  chalClose.addEventListener('click', () => chalModal.classList.add('sfb-hidden'));
  chalHead.append(chalClose);
  const chalList = h('ul', 'sfb-b-chal-list');
  chalCard.append(chalHead, chalList);
  chalModal.append(chalCard);
  chalModal.addEventListener('click', (e) => {
    if (e.target === chalModal) chalModal.classList.add('sfb-hidden');
  });

  function renderChallenges(completed: Set<string>): void {
    chalList.textContent = '';
    for (const ch of CHALLENGES) {
      const done = completed.has(ch.id);
      const li = h('li', `sfb-b-chal-item${done ? ' is-done' : ''}`);
      li.append(
        h('div', 'sfb-b-chal-row', done ? `✓ ${ch.title}` : ch.title),
        h('p', 'sfb-b-part-sub', ch.description),
      );
      chalList.append(li);
    }
  }

  // ===== Short dismissible first-run tutorial =====
  const tutorial = h('div', 'sfb-panel sfb-b-tutorial sfb-hidden');
  tutorial.append(
    h('h3', 'sfb-section-title', 'Quick Start'),
    h('p', 'sfb-hint', '1. Pick a part from the palette, then tap a glowing snap ring on the rocket.'),
    h('p', 'sfb-hint', '2. Select any part to adjust dimensions, fins, motor, or colour — watch CG (blue) & CP (red) update live.'),
    h('p', 'sfb-hint', '3. Press Go to Pad to launch and review flight flaws.'),
  );
  const tutBtn = h('button', 'sfb-btn sfb-btn-primary sfb-b-mini-btn', 'Got it');
  tutBtn.type = 'button';
  tutBtn.addEventListener('click', () => {
    tutorial.classList.add('sfb-hidden');
    try {
      globalThis.localStorage?.setItem(TUTORIAL_KEY, '1');
    } catch {
      /* ignore */
    }
  });
  tutorial.append(tutBtn);

  function maybeShowTutorial(): void {
    try {
      if (globalThis.localStorage?.getItem(TUTORIAL_KEY) === '1') return;
    } catch {
      return;
    }
    tutorial.classList.remove('sfb-hidden');
  }

  root.append(topBar, snapBanner, palettePanel, rightPanel, mobileBar, tutorial, filesModal, chalModal);
  container.append(root);

  // Sync .sfb-mobile class with viewport width/height.
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null;
  const syncMobile = (): void => {
    root.classList.toggle('sfb-mobile', mql?.matches ?? false);
  };
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', syncMobile);
    else mql.addListener(syncMobile);
    syncMobile();
  }

  // ===== Desktop keyboard shortcuts for Build Mode =====
  let lastSelectedId: string | null = null;
  window.addEventListener('keydown', (e) => {
    if (root.classList.contains('sfb-hidden')) return;
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
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) cb.onRedo();
      else cb.onUndo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      cb.onRedo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd' && lastSelectedId) {
      e.preventDefault();
      cb.onDuplicatePart(lastSelectedId);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && lastSelectedId) {
      e.preventDefault();
      cb.onDeletePart(lastSelectedId);
      return;
    }
    if (e.key === 'Escape') {
      if (activePlacingId) cb.onCancelPlace();
      else if (lastSelectedId) cb.onSelectPart(null);
    }
  });

  // ===== Inspector builders =====

  function sliderControl(opts: {
    label: string;
    unit: string;
    value: number;
    min: number;
    max: number;
    step: number;
    digits?: number;
    onChange(val: number, commit: boolean): void;
  }): HTMLElement {
    const wrap = h('div', 'sfb-b-ctrl');
    const head = h('div', 'sfb-b-ctrl-head');
    head.append(h('span', 'sfb-b-ctrl-label', `${opts.label} (${opts.unit})`));

    const num = h('input', 'sfb-input sfb-b-ctrl-num');
    num.type = 'number';
    num.inputMode = 'decimal';
    num.min = String(opts.min);
    num.step = String(opts.step);
    const digits = opts.digits ?? (opts.step < 1 ? 1 : 0);
    num.value = opts.value.toFixed(digits);

    const range = h('input', 'sfb-b-slider');
    range.type = 'range';
    range.min = String(opts.min);
    range.max = String(Math.max(opts.max, opts.value));
    range.step = String(opts.step);
    range.value = String(opts.value);

    let committedDrag = false;
    range.addEventListener('pointerdown', () => {
      committedDrag = false;
    });
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      if (!Number.isFinite(v)) return;
      num.value = v.toFixed(digits);
      // Push undo snapshot on first tick of drag, replace thereafter.
      opts.onChange(v, !committedDrag);
      committedDrag = true;
    });
    range.addEventListener('change', () => {
      committedDrag = false;
    });

    num.addEventListener('change', () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      const clamped = Math.max(opts.min, v);
      range.max = String(Math.max(parseFloat(range.max), clamped));
      range.value = String(clamped);
      opts.onChange(clamped, true);
    });

    head.append(num);
    wrap.append(head, range);
    return wrap;
  }

  function selectControl(opts: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange(val: string): void;
  }): HTMLElement {
    const wrap = h('label', 'sfb-b-ctrl');
    wrap.append(h('span', 'sfb-b-ctrl-label', opts.label));
    const sel = h('select', 'sfb-select');
    for (const o of opts.options) {
      sel.append(new Option(o.label, o.value));
    }
    sel.value = opts.value;
    sel.addEventListener('change', () => opts.onChange(sel.value));
    wrap.append(sel);
    return wrap;
  }

  function materialControl(partId: string, density: number): HTMLElement {
    const current = nearestMaterialDensity(density);
    const options = MATERIALS.map((m) => ({
      value: String(m.density),
      label: `${m.name} (${m.density} kg/m³)`,
    }));
    if (current === 'custom') {
      options.unshift({ value: 'custom', label: `Custom (${Math.round(density)} kg/m³)` });
    }
    return selectControl({
      label: 'Material',
      value: current,
      options,
      onChange: (v) => {
        const d = parseFloat(v);
        if (Number.isFinite(d)) cb.onUpdatePart(partId, { part: { density: d } }, true);
      },
    });
  }

  function colorControl(partId: string, current?: number): HTMLElement {
    const wrap = h('div', 'sfb-b-ctrl');
    wrap.append(h('span', 'sfb-b-ctrl-label', 'Colour'));
    const row = h('div', 'sfb-b-swatches');
    for (const sw of PART_SWATCHES) {
      const b = h('button', `sfb-b-swatch${current === sw.hex ? ' is-active' : ''}`);
      b.type = 'button';
      b.title = sw.label;
      b.setAttribute('aria-label', sw.label);
      b.style.background = `#${sw.hex.toString(16).padStart(6, '0')}`;
      b.addEventListener('click', () => {
        lastInspectorKey = '';
        cb.onUpdatePart(partId, { part: { color: sw.hex } }, true);
      });
      row.append(b);
    }
    wrap.append(row);
    return wrap;
  }

  function anchorControls(partId: string, anchor: AnchorMode, offset: number): HTMLElement[] {
    return [
      selectControl({
        label: 'Position Reference',
        value: anchor,
        options: [
          { value: 'top', label: 'Top of tube' },
          { value: 'middle', label: 'Middle of tube' },
          { value: 'bottom', label: 'Bottom of tube' },
        ],
        onChange: (v) => cb.onUpdatePart(partId, { anchor: v as AnchorMode }, true),
      }),
      sliderControl({
        label: 'Axial Offset',
        unit: 'cm',
        value: offset * 100,
        min: -30,
        max: 30,
        step: 0.2,
        digits: 1,
        onChange: (cm, commit) => cb.onUpdatePart(partId, { offset: cm / 100 }, commit),
      }),
    ];
  }

  let lastInspectorKey = '';

  function renderInspector(state: BuilderRenderState): void {
    const { design, selectedId, motors, forceInspectorRefresh } = state;
    const found = selectedId ? findPart(design, selectedId) : null;
    if (!found) {
      lastInspectorKey = '';
      inspectorWrap.classList.add('sfb-hidden');
      inspectorWrap.textContent = '';
      return;
    }

    const key = `${found.part.id}:${found.part.kind}:${design.stack.length}:${found.stackIndex}`;
    if (!forceInspectorRefresh && key === lastInspectorKey) {
      return;
    }
    lastInspectorKey = key;

    inspectorWrap.classList.remove('sfb-hidden');
    inspectorWrap.textContent = '';

    const part = found.part;
    const head = h('div', 'sfb-b-insp-head');
    head.append(h('h3', 'sfb-section-title', `Edit ${part.name}`));

    const acts = h('div', 'sfb-b-insp-actions');
    if (found.parentId === null) {
      const upBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Move ▲');
      upBtn.type = 'button';
      upBtn.title = 'Move forward in stack';
      upBtn.disabled = found.stackIndex <= 0;
      upBtn.addEventListener('click', () => cb.onMovePart(part.id, -1));

      const dnBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Move ▼');
      dnBtn.type = 'button';
      dnBtn.title = 'Move aft in stack';
      dnBtn.disabled = found.stackIndex >= design.stack.length - 1;
      dnBtn.addEventListener('click', () => cb.onMovePart(part.id, 1));
      acts.append(upBtn, dnBtn);
    } else {
      const curOffset = found.offset ?? 0;
      const foreBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Move ▲');
      foreBtn.type = 'button';
      foreBtn.title = 'Nudge 2 cm forward along tube';
      foreBtn.addEventListener('click', () => {
        lastInspectorKey = '';
        cb.onUpdatePart(part.id, { offset: Math.max(-0.3, Number((curOffset - 0.02).toFixed(4))) }, true);
      });

      const aftBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Move ▼');
      aftBtn.type = 'button';
      aftBtn.title = 'Nudge 2 cm aft along tube';
      aftBtn.addEventListener('click', () => {
        lastInspectorKey = '';
        cb.onUpdatePart(part.id, { offset: Math.min(0.3, Number((curOffset + 0.02).toFixed(4))) }, true);
      });
      acts.append(foreBtn, aftBtn);
    }

    const dupBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Dup');
    dupBtn.type = 'button';
    dupBtn.title = 'Duplicate (Ctrl+D)';
    dupBtn.addEventListener('click', () => cb.onDuplicatePart(part.id));

    const delBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-warn-btn', 'Del');
    delBtn.type = 'button';
    delBtn.title = 'Delete (Del)';
    delBtn.addEventListener('click', () => cb.onDeletePart(part.id));

    acts.append(dupBtn, delBtn);
    head.append(acts);
    inspectorWrap.append(head);

    const fields = h('div', 'sfb-b-insp-fields');
    const patch = (p: Partial<Component>, commit: boolean): void =>
      cb.onUpdatePart(part.id, { part: p }, commit);

    switch (part.kind) {
      case 'nosecone': {
        const nc = part as NoseCone;
        fields.append(
          selectControl({
            label: 'Shape',
            value: nc.shape,
            options: NOSE_SHAPES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
            onChange: (v) => patch({ shape: v as NoseShape } as Partial<NoseCone>, true),
          }),
          sliderControl({
            label: 'Length',
            unit: 'cm',
            value: nc.length * 100,
            min: 2,
            max: 50,
            step: 0.5,
            digits: 1,
            onChange: (cm, commit) => patch({ length: cm / 100 }, commit),
          }),
          sliderControl({
            label: 'Base Diameter',
            unit: 'mm',
            value: nc.baseRadius * 2000,
            min: 10,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ baseRadius: mm / 2000 } as Partial<NoseCone>, commit),
          }),
          sliderControl({
            label: 'Wall Thickness',
            unit: 'mm',
            value: nc.thickness * 1000,
            min: 0,
            max: 8,
            step: 0.1,
            digits: 1,
            onChange: (mm, commit) => patch({ thickness: mm / 1000 } as Partial<NoseCone>, commit),
          }),
          materialControl(part.id, nc.density),
        );
        break;
      }

      case 'bodytube': {
        const bt = part as BodyTube;
        fields.append(
          sliderControl({
            label: 'Length',
            unit: 'cm',
            value: bt.length * 100,
            min: 3,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (cm, commit) => patch({ length: cm / 100 }, commit),
          }),
          sliderControl({
            label: 'Outer Diameter',
            unit: 'mm',
            value: bt.outerRadius * 2000,
            min: 12,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ outerRadius: mm / 2000 } as Partial<BodyTube>, commit),
          }),
          sliderControl({
            label: 'Wall Thickness',
            unit: 'mm',
            value: bt.thickness * 1000,
            min: 0.2,
            max: 6,
            step: 0.1,
            digits: 1,
            onChange: (mm, commit) => patch({ thickness: mm / 1000 } as Partial<BodyTube>, commit),
          }),
          materialControl(part.id, bt.density),
        );
        break;
      }

      case 'transition': {
        const tr = part as Transition;
        fields.append(
          sliderControl({
            label: 'Length',
            unit: 'cm',
            value: tr.length * 100,
            min: 1,
            max: 40,
            step: 0.5,
            digits: 1,
            onChange: (cm, commit) => patch({ length: cm / 100 }, commit),
          }),
          sliderControl({
            label: 'Fore Diameter',
            unit: 'mm',
            value: tr.foreRadius * 2000,
            min: 10,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ foreRadius: mm / 2000 } as Partial<Transition>, commit),
          }),
          sliderControl({
            label: 'Aft Diameter',
            unit: 'mm',
            value: tr.aftRadius * 2000,
            min: 10,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ aftRadius: mm / 2000 } as Partial<Transition>, commit),
          }),
          materialControl(part.id, tr.density),
        );
        break;
      }

      case 'finset': {
        const fn = part as FinSet;
        // Quick symmetry buttons for 3 / 4 / 6 fins + full count slider
        const symRow = h('div', 'sfb-b-sym-row');
        symRow.append(h('span', 'sfb-b-ctrl-label', 'Fin Count (Symmetry)'));
        const symBtns = h('div', 'sfb-b-sym-btns');
        for (const n of [3, 4, 5, 6]) {
          const b = h('button', `sfb-btn sfb-b-mini-btn${fn.count === n ? ' is-active' : ''}`, `${n}×`);
          b.type = 'button';
          b.addEventListener('click', () => {
            lastInspectorKey = '';
            patch({ count: n } as Partial<FinSet>, true);
          });
          symBtns.append(b);
        }
        symRow.append(symBtns);

        fields.append(
          symRow,
          selectControl({
            label: 'Fin Shape',
            value: fn.finShape === 'elliptical' ? 'elliptical' : 'trapezoid',
            options: [
              { value: 'trapezoid', label: 'Trapezoid' },
              { value: 'elliptical', label: 'Elliptical' },
            ],
            onChange: (v) => {
              lastInspectorKey = '';
              patch({ finShape: v as FinSet['finShape'] } as Partial<FinSet>, true);
            },
          }),
          sliderControl({
            label: 'Root Chord',
            unit: 'mm',
            value: fn.rootChord * 1000,
            min: 10,
            max: 250,
            step: 1,
            digits: 0,
            onChange: (mm, commit) =>
              patch({ rootChord: mm / 1000, length: mm / 1000 } as Partial<FinSet>, commit),
          }),
          ...(fn.finShape !== 'elliptical'
            ? [
                sliderControl({
                  label: 'Tip Chord',
                  unit: 'mm',
                  value: fn.tipChord * 1000,
                  min: 0,
                  max: 200,
                  step: 1,
                  digits: 0,
                  onChange: (mm, commit) => patch({ tipChord: mm / 1000 } as Partial<FinSet>, commit),
                }),
                sliderControl({
                  label: 'Sweep',
                  unit: 'mm',
                  value: fn.sweepLength * 1000,
                  min: -40,
                  max: 200,
                  step: 1,
                  digits: 0,
                  onChange: (mm, commit) => patch({ sweepLength: mm / 1000 } as Partial<FinSet>, commit),
                }),
              ]
            : []),
          sliderControl({
            label: 'Span',
            unit: 'mm',
            value: fn.span * 1000,
            min: 10,
            max: 180,
            step: 1,
            digits: 0,
            onChange: (mm, commit) => patch({ span: mm / 1000 } as Partial<FinSet>, commit),
          }),
          sliderControl({
            label: 'Thickness',
            unit: 'mm',
            value: fn.thickness * 1000,
            min: 0.5,
            max: 8,
            step: 0.2,
            digits: 1,
            onChange: (mm, commit) => patch({ thickness: mm / 1000 } as Partial<FinSet>, commit),
          }),
          materialControl(part.id, fn.density),
          ...anchorControls(part.id, found.anchor ?? 'bottom', found.offset ?? 0),
        );
        break;
      }

      case 'innertube': {
        const it = part as InnerTube;
        if (it.radialCount && it.radialCount >= 2) {
          const symRow = h('div', 'sfb-b-sym-row');
          symRow.append(h('span', 'sfb-b-ctrl-label', 'Booster Symmetry'));
          const symBtns = h('div', 'sfb-b-sym-btns');
          for (const n of [2, 3, 4]) {
            const b = h('button', `sfb-btn sfb-b-mini-btn${it.radialCount === n ? ' is-active' : ''}`, `${n}×`);
            b.type = 'button';
            b.addEventListener('click', () => {
              lastInspectorKey = '';
              patch({ radialCount: n } as Partial<InnerTube>, true);
            });
            symBtns.append(b);
          }
          symRow.append(symBtns);
          fields.append(symRow);
        }
        const currentMotorKey = it.motor ? `${it.motor.manufacturer} ${it.motor.designation}`.trim() : '';
        const motorOptions = [
          { value: '', label: 'None (empty tube)' },
          ...motors.map((m) => ({
            value: motorKey(m),
            label: `${motorKey(m)} (${(m.diameter * 1000).toFixed(0)}mm · ${Math.round(m.totalImpulse)} N·s)`,
          })),
        ];
        fields.append(
          selectControl({
            label: 'Installed Motor',
            value: motorOptions.some((o) => o.value === currentMotorKey) ? currentMotorKey : '',
            options: motorOptions,
            onChange: (val) => {
              lastInspectorKey = '';
              const picked = motors.find((m) => motorKey(m) === val);
              if (!picked) {
                patch({ motor: undefined, isMotorMount: true } as Partial<InnerTube>, true);
              } else {
                patch(
                  {
                    isMotorMount: true,
                    motor: {
                      manufacturer: picked.manufacturer,
                      designation: picked.designation,
                      diameter: picked.diameter,
                      length: picked.length,
                      delay: it.motor?.delay ?? 5,
                    },
                  } as Partial<InnerTube>,
                  true,
                );
              }
            },
          }),
          sliderControl({
            label: 'Ejection Delay',
            unit: 's',
            value: Number.isFinite(it.motor?.delay) ? (it.motor!.delay as number) : 5,
            min: 0,
            max: 15,
            step: 0.5,
            digits: 1,
            onChange: (s, commit) => {
              if (!it.motor) return;
              patch({ motor: { ...it.motor, delay: s } } as Partial<InnerTube>, commit);
            },
          }),
          sliderControl({
            label: 'Outer Diameter',
            unit: 'mm',
            value: it.outerRadius * 2000,
            min: 10,
            max: 80,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ outerRadius: mm / 2000 } as Partial<InnerTube>, commit),
          }),
          sliderControl({
            label: 'Mount Length',
            unit: 'cm',
            value: it.length * 100,
            min: 3,
            max: 45,
            step: 0.5,
            digits: 1,
            onChange: (cm, commit) => patch({ length: cm / 100 }, commit),
          }),
          ...anchorControls(part.id, found.anchor ?? 'bottom', found.offset ?? 0),
        );
        break;
      }

      case 'parachute': {
        const ch = part as Parachute;
        fields.append(
          sliderControl({
            label: 'Canopy Diameter',
            unit: 'cm',
            value: ch.diameter * 100,
            min: 10,
            max: 180,
            step: 2,
            digits: 0,
            onChange: (cm, commit) => patch({ diameter: cm / 100 } as Partial<Parachute>, commit),
          }),
          sliderControl({
            label: 'Drag Cd',
            unit: '—',
            value: ch.cd,
            min: 0.4,
            max: 1.5,
            step: 0.05,
            digits: 2,
            onChange: (v, commit) => patch({ cd: v } as Partial<Parachute>, commit),
          }),
          selectControl({
            label: 'Deploy Event',
            value: ch.deployEvent,
            options: [
              { value: 'ejection', label: 'Motor ejection charge' },
              { value: 'apogee', label: 'At apogee (altimeter)' },
              { value: 'altitude', label: 'Descending altitude' },
            ],
            onChange: (v) => {
              lastInspectorKey = '';
              patch({ deployEvent: v as Parachute['deployEvent'] } as Partial<Parachute>, true);
            },
          }),
          ...(ch.deployEvent === 'altitude'
            ? [
                sliderControl({
                  label: 'Deploy Altitude',
                  unit: 'm',
                  value: ch.deployAltitude || 150,
                  min: 30,
                  max: 600,
                  step: 10,
                  digits: 0,
                  onChange: (m, commit) => patch({ deployAltitude: m } as Partial<Parachute>, commit),
                }),
              ]
            : []),
          sliderControl({
            label: 'Mass',
            unit: 'g',
            value: ch.mass * 1000,
            min: 1,
            max: 200,
            step: 1,
            digits: 0,
            onChange: (g, commit) => patch({ mass: g / 1000 } as Partial<Parachute>, commit),
          }),
          ...anchorControls(part.id, found.anchor ?? 'top', found.offset ?? 0),
        );
        break;
      }

      case 'mass': {
        const mc = part as MassComponent;
        fields.append(
          sliderControl({
            label: 'Mass',
            unit: 'g',
            value: mc.mass * 1000,
            min: 1,
            max: 500,
            step: 1,
            digits: 0,
            onChange: (g, commit) => patch({ mass: g / 1000 } as Partial<MassComponent>, commit),
          }),
          sliderControl({
            label: 'Length',
            unit: 'cm',
            value: mc.length * 100,
            min: 0.5,
            max: 25,
            step: 0.5,
            digits: 1,
            onChange: (cm, commit) => patch({ length: cm / 100 }, commit),
          }),
          ...anchorControls(part.id, found.anchor ?? 'top', found.offset ?? 0),
        );
        break;
      }

      case 'ring': {
        const rg = part as Ring;
        fields.append(
          sliderControl({
            label: 'Outer Diameter',
            unit: 'mm',
            value: rg.outerRadius * 2000,
            min: 4,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ outerRadius: mm / 2000 } as Partial<Ring>, commit),
          }),
          sliderControl({
            label: 'Inner Diameter',
            unit: 'mm',
            value: rg.innerRadius * 2000,
            min: 0,
            max: 110,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ innerRadius: mm / 2000 } as Partial<Ring>, commit),
          }),
          sliderControl({
            label: 'Thickness',
            unit: 'mm',
            value: rg.length * 1000,
            min: 1,
            max: 60,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ length: mm / 1000 }, commit),
          }),
          materialControl(part.id, rg.density),
          ...anchorControls(part.id, found.anchor ?? 'bottom', found.offset ?? 0),
        );
        break;
      }
    }

    if (part.kind === 'nosecone' || part.kind === 'bodytube' || part.kind === 'transition' || part.kind === 'finset' || (part.kind === 'innertube' && (part as InnerTube).radialCount)) {
      fields.append(colorControl(part.id, part.color));
    }

    inspectorWrap.append(fields);
  }

  function renderFlaws(flaws: Flaw[]): void {
    flawsWrap.textContent = '';
    if (flaws.length === 0) {
      flawsWrap.classList.add('sfb-hidden');
      return;
    }
    flawsWrap.classList.remove('sfb-hidden');
    flawsWrap.append(h('h3', 'sfb-section-title', `Design Checks (${flaws.length})`));
    const ul = h('ul', 'sfb-flaws');
    for (const f of flaws) {
      const li = h('li', `sfb-flaw sev-${f.severity}`);
      li.append(
        h('span', 'sfb-pill', f.severity),
        h('p', 'sfb-flaw-title', f.title),
        h('p', 'sfb-flaw-detail', f.detail),
      );
      ul.append(li);
    }
    flawsWrap.append(ul);
  }

  function render(state: BuilderRenderState): void {
    const { design, selectedId, stats } = state;
    lastSelectedId = selectedId;

    if (document.activeElement !== nameInput) {
      nameInput.value = design.name;
    }

    undoBtn.disabled = !state.canUndo;
    redoBtn.disabled = !state.canRedo;
    mUndoBtn.disabled = !state.canUndo;
    mRedoBtn.disabled = !state.canRedo;

    sLen.val.textContent = stats.length > 0 ? `${(stats.length * 100).toFixed(1)} cm` : '—';
    sMass.val.textContent = stats.mass > 0 ? `${(stats.mass * 1000).toFixed(0)} g` : '—';
    if (stats.length > 0 && Number.isFinite(stats.stabilityCal)) {
      sStab.val.textContent = `${stats.stabilityCal.toFixed(2)} cal`;
      sStab.val.className = `sfb-b-stat-v ${stabilityClass(stats.stabilityCal)}`;
    } else {
      sStab.val.textContent = '—';
      sStab.val.className = 'sfb-b-stat-v';
    }
    sTwr.val.textContent = stats.twr !== null && Number.isFinite(stats.twr) ? `${stats.twr.toFixed(1)}×` : '—';

    stackList.textContent = '';
    const empty = design.stack.length === 0;
    stackEmpty.classList.toggle('sfb-hidden', !empty);
    stackList.classList.toggle('sfb-hidden', empty);

    const flawsByPart = mapFlawsToParts(stats.flaws, design);
    const makeFlawTag = (partId: string): HTMLElement | null => {
      const list = flawsByPart.get(partId);
      if (!list || list.length === 0) return null;
      const worst = list.some((f) => f.severity === 'critical')
        ? 'critical'
        : list.some((f) => f.severity === 'warning')
          ? 'warning'
          : 'info';
      const tag = h('span', `sfb-b-part-flaw sev-${worst}`, String(list.length));
      tag.title = list.map((f) => `${f.title}: ${f.fix}`).join('\n');
      return tag;
    };

    let draggedStackPart: { id: string; index: number } | null = null;

    for (let stackIdx = 0; stackIdx < design.stack.length; stackIdx++) {
      const node = design.stack[stackIdx];
      const li = h('li', 'sfb-b-stack-item');
      const row = h('div', `sfb-b-stack-row${node.id === selectedId ? ' is-selected' : ''}`);
      row.dataset.partId = node.id;
      row.dataset.stackIndex = String(stackIdx);

      if (design.stack.length > 1) {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          draggedStackPart = { id: node.id, index: stackIdx };
          row.classList.add('is-dragging');
          e.dataTransfer?.setData('text/plain', node.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
          draggedStackPart = null;
          row.classList.remove('is-dragging');
          for (const el of stackList.querySelectorAll('.is-drag-over')) {
            el.classList.remove('is-drag-over');
          }
        });
        row.addEventListener('dragover', (e) => {
          if (!draggedStackPart || draggedStackPart.id === node.id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          row.classList.add('is-drag-over');
        });
        row.addEventListener('dragleave', () => {
          row.classList.remove('is-drag-over');
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('is-drag-over');
          if (!draggedStackPart || draggedStackPart.id === node.id) return;
          const delta = stackIdx - draggedStackPart.index;
          const movedId = draggedStackPart.id;
          draggedStackPart = null;
          if (delta !== 0) {
            cb.onMovePart(movedId, delta);
          }
        });
      }

      const grip = h('span', 'sfb-b-drag-handle', '⋮⋮');
      grip.title = 'Drag to reorder block';
      grip.setAttribute('aria-hidden', 'true');

      const labelBtn = h('button', 'sfb-b-stack-label', node.part.name);
      labelBtn.type = 'button';
      labelBtn.addEventListener('click', () => cb.onSelectPart(node.id));

      const upBtn = h('button', 'sfb-b-move sfb-b-move-up', '▲');
      upBtn.type = 'button';
      upBtn.title = `Move ${node.part.name} forward`;
      upBtn.setAttribute('aria-label', `Move ${node.part.name} up`);
      upBtn.disabled = stackIdx === 0;
      upBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onMovePart(node.id, -1);
      });

      const dnBtn = h('button', 'sfb-b-move sfb-b-move-down', '▼');
      dnBtn.type = 'button';
      dnBtn.title = `Move ${node.part.name} aft`;
      dnBtn.setAttribute('aria-label', `Move ${node.part.name} down`);
      dnBtn.disabled = stackIdx === design.stack.length - 1;
      dnBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onMovePart(node.id, 1);
      });

      const delBtn = h('button', 'sfb-b-del', '×');
      delBtn.type = 'button';
      delBtn.title = `Remove ${node.part.name}`;
      delBtn.setAttribute('aria-label', `Remove ${node.part.name}`);
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onDeletePart(node.id);
      });

      const nodeTag = makeFlawTag(node.id);
      if (nodeTag) row.append(grip, labelBtn, nodeTag, upBtn, dnBtn, delBtn);
      else row.append(grip, labelBtn, upBtn, dnBtn, delBtn);
      li.append(row);

      if (node.children.length > 0) {
        const sub = h('ul', 'sfb-b-sublist');
        for (const ch of node.children) {
          const cli = h('li', `sfb-b-stack-row sfb-b-child-row${ch.id === selectedId ? ' is-selected' : ''}`);
          cli.dataset.partId = ch.id;
          const clabel = h('button', 'sfb-b-stack-label', ch.part.name);
          clabel.type = 'button';
          clabel.addEventListener('click', () => cb.onSelectPart(ch.id));

          const cup = h('button', 'sfb-b-move sfb-b-move-up', '▲');
          cup.type = 'button';
          cup.title = `Nudge ${ch.part.name} 2 cm forward`;
          cup.setAttribute('aria-label', `Move ${ch.part.name} forward`);
          cup.addEventListener('click', (e) => {
            e.stopPropagation();
            lastInspectorKey = '';
            const nextOffset = Math.max(-0.3, Number(((ch.offset ?? 0) - 0.02).toFixed(4)));
            cb.onUpdatePart(ch.id, { offset: nextOffset }, true);
          });

          const cdn = h('button', 'sfb-b-move sfb-b-move-down', '▼');
          cdn.type = 'button';
          cdn.title = `Nudge ${ch.part.name} 2 cm aft`;
          cdn.setAttribute('aria-label', `Move ${ch.part.name} aft`);
          cdn.addEventListener('click', (e) => {
            e.stopPropagation();
            lastInspectorKey = '';
            const nextOffset = Math.min(0.3, Number(((ch.offset ?? 0) + 0.02).toFixed(4)));
            cb.onUpdatePart(ch.id, { offset: nextOffset }, true);
          });

          const cdel = h('button', 'sfb-b-del', '×');
          cdel.type = 'button';
          cdel.title = `Remove ${ch.part.name}`;
          cdel.setAttribute('aria-label', `Remove ${ch.part.name}`);
          cdel.addEventListener('click', (e) => {
            e.stopPropagation();
            cb.onDeletePart(ch.id);
          });

          const childTag = makeFlawTag(ch.id);
          if (childTag) cli.append(clabel, childTag, cup, cdn, cdel);
          else cli.append(clabel, cup, cdn, cdel);
          sub.append(cli);
        }
        li.append(sub);
      }
      stackList.append(li);
    }

    renderInspector(state);
    renderFlaws(stats.flaws);
    renderSavedDesigns(state.savedDesigns);
    renderChallenges(state.completedChallenges);
  }

  function setPlacing(preset: PartPreset | null, snaps: SnapPoint[]): void {
    activePlacingId = preset?.presetId ?? null;
    renderPalette();
    snapBanner.textContent = '';
    if (!preset) {
      snapBanner.classList.add('sfb-hidden');
      return;
    }
    snapBanner.classList.remove('sfb-hidden');
    const msg = h(
      'div',
      'sfb-b-snap-msg',
      snaps.length > 0
        ? `Tap a glowing ring to place ${preset.label}`
        : `No valid snap point for ${preset.label}`,
    );
    const actions = h('div', 'sfb-b-snap-actions');
    for (const s of snaps.slice(0, 4)) {
      const b = h(
        'button',
        `sfb-btn sfb-b-mini-btn${s.diameterMatch ? '' : ' sfb-b-warn-btn'}`,
        s.label,
      );
      b.type = 'button';
      b.addEventListener('click', () => cb.onChooseSnap(s));
      actions.append(b);
    }
    const cancel = h('button', 'sfb-btn sfb-b-mini-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cb.onCancelPlace());
    actions.append(cancel);
    snapBanner.append(msg, actions);
  }

  function setTransitionPrompt(prompt: TransitionPrompt | null): void {
    if (!prompt) {
      snapBanner.classList.add('sfb-hidden');
      snapBanner.textContent = '';
      return;
    }
    snapBanner.classList.remove('sfb-hidden');
    snapBanner.textContent = '';
    const msg = h(
      'div',
      'sfb-b-snap-msg',
      `Diameter mismatch (${prompt.snap.warning ?? ''}). Insert an automatic transition?`,
    );
    const actions = h('div', 'sfb-b-snap-actions');
    const withTr = h('button', 'sfb-btn sfb-btn-primary sfb-b-mini-btn', 'Place + Transition');
    withTr.type = 'button';
    withTr.addEventListener('click', () => cb.onChooseSnap(prompt.snap, true));

    const plain = h('button', 'sfb-btn sfb-b-mini-btn', 'Place Without');
    plain.type = 'button';
    plain.addEventListener('click', () => cb.onChooseSnap(prompt.snap, false));

    const cancel = h('button', 'sfb-btn sfb-b-mini-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cb.onCancelPlace());

    actions.append(withTr, plain, cancel);
    snapBanner.append(msg, actions);
  }

  return {
    root,
    setVisible(visible: boolean) {
      root.classList.toggle('sfb-hidden', !visible);
      if (visible) maybeShowTutorial();
      else setMobileDrawer('none');
    },
    render,
    setPlacing,
    setTransitionPrompt,
    setCutaway(on: boolean) {
      cutawayOn = on;
      cutawayBtn.classList.toggle('is-active', on);
      mCutawayBtn.classList.toggle('is-active', on);
    },
  };
}
