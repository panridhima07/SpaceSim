// DOM UI for Build Mode: parts palette (search, category rail, "fits" filter, drag onto
// the rocket), snap banner, rocket stack, live part inspector (sliders + number boxes),
// floating view bar (zoom, centre, see inside, mirror), undo/redo, and Launch.
// Works in both desktop layout and .sfb-mobile phone layout (44px+ touch targets).

import {
  aftRadiusOf,
  findPart,
  foreRadiusOf,
  innerRadiusOf,
  mapFlawsToParts,
  type Design,
  type PartPatch,
} from '../builder/design';
import {
  MATERIALS,
  PART_CATEGORIES,
  PART_PRESETS,
  type AnchorMode,
  type PartCategory,
  type PartPreset,
} from '../builder/parts';
import {
  CATEGORY_HELP,
  FRIENDLY_CATEGORY,
  friendlyName,
  friendlyPart,
  iconSvg,
  matchesSearch,
  type FriendlyPart,
} from '../builder/friendly';
import type { SnapPoint } from '../builder/snap';
import { partThumbSvg } from '../builder/partThumb';
import type { SavedDesign } from '../builder/storage';
import { CHALLENGES } from '../builder/challenges';
import { IMPORT_ACCEPT } from '../io/importer';
import { EXPORT_FORMATS, type ExportFormat } from '../io/exporter';
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
  /** Pointer drag of a palette card: called on every move with client coordinates. */
  onDragMovePreset?(clientX: number, clientY: number, overStage: boolean): void;
  /** Card released. `overStage` is false when it was dropped back on a panel. */
  onDropPreset?(clientX: number, clientY: number, overStage: boolean): void;
  onToggleMirror?(on: boolean): void;
  onZoom?(factor: number): void;
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
  onExport(format: ExportFormat): void;
  onCopyShareLink(): void;
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
  /** True when `preset` can be added to the current rocket without an adapter. */
  fits?(preset: PartPreset): boolean;
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
  setMirror(on: boolean): void;
  /** Show a small label that follows the pointer while a part is dragged; null hides it. */
  setDragGhost(text: string | null, clientX?: number, clientY?: number): void;
}

// A short window on a laptop (browser zoomed, or 125-150 % display scaling) is still a
// laptop: only treat a short viewport as a phone when the pointer is a finger.
const MOBILE_QUERY = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';
const NOSE_SHAPES: readonly NoseShape[] = ['ogive', 'conical', 'ellipsoid', 'parabolic', 'power', 'haack'];
const TUTORIAL_KEY = 'sfb.builder.tutorial.v2';
const FITS_KEY = 'sfb.builder.fitsOnly.v1';
const DRAG_START_PX = 6;
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

function stabilityWord(cal: number): string {
  if (cal < 1) return 'Unstable';
  if (cal <= 1.5) return 'Wobbly';
  if (cal > 3) return 'Too stiff';
  return 'Stable';
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
  // Phones hide the top bar's name box; this one sits in the Edit drawer.
  const mNameInput = h('input', 'sfb-input sfb-b-mobile-only sfb-b-mobile-name');
  mNameInput.type = 'text';
  mNameInput.value = nameInput.value;
  mNameInput.setAttribute('aria-label', 'Rocket name');
  mNameInput.addEventListener('change', () => cb.onRename(mNameInput.value.trim() || 'New Rocket'));

  const statsEl = h('div', 'sfb-b-stats');
  const makeStat = (label: string): { el: HTMLElement; val: HTMLElement } => {
    const wrap = h('div', 'sfb-b-stat');
    const val = h('span', 'sfb-b-stat-v', '—');
    wrap.append(h('span', 'sfb-b-stat-k', label), val);
    statsEl.append(wrap);
    return { el: wrap, val };
  };
  const sLen = makeStat('Height');
  sLen.el.title = 'How tall the rocket is, nose tip to tail';
  const sMass = makeStat('Weight');
  sMass.el.title = 'Total weight on the pad, engine included';
  const sStab = makeStat('Flies straight?');
  sStab.el.title =
    'Stable rockets fly straight. Wobbly or unstable? Add bigger fins at the bottom or weight in the nose.';
  const sTwr = makeStat('Engine power');
  sTwr.el.title = 'How many times its own weight the engine can lift. Under 5× is too weak to leave the pad safely.';

  const topActions = h('div', 'sfb-b-top-actions');

  const undoBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Undo');
  undoBtn.type = 'button';
  undoBtn.title = 'Undo (Ctrl+Z)';
  undoBtn.addEventListener('click', () => cb.onUndo());

  const redoBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Redo');
  redoBtn.type = 'button';
  redoBtn.title = 'Redo (Ctrl+Y)';
  redoBtn.addEventListener('click', () => cb.onRedo());

  /** A two-state button: its look and what a screen reader is told. */
  const setPressed = (btn: HTMLButtonElement, on: boolean): void => {
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  };

  let cutawayOn = false;
  const cutawayBtn = h('button', 'sfb-btn', 'See inside');
  cutawayBtn.type = 'button';
  cutawayBtn.title = 'Cut the rocket open to see and pick the parts inside';
  setPressed(cutawayBtn, false);
  cutawayBtn.addEventListener('click', () => {
    showCutaway(!cutawayOn);
    cb.onToggleCutaway(cutawayOn);
  });

  const fitBtn = h('button', 'sfb-btn', 'Center');
  fitBtn.type = 'button';
  fitBtn.title = 'Bring the whole rocket back into view';
  fitBtn.addEventListener('click', () => cb.onFrameCamera());

  const filesBtn = h('button', 'sfb-btn', 'Save / Open');
  filesBtn.type = 'button';
  filesBtn.addEventListener('click', () => toggleFilesModal());

  const exportBtn = h('button', 'sfb-btn', 'Export');
  exportBtn.type = 'button';
  exportBtn.title = 'Export rocket (.ork, .json, 3D) or copy share link';
  exportBtn.addEventListener('click', () => openFilesModal(true));

  const chalBtn = h('button', 'sfb-btn', 'Challenges');
  chalBtn.type = 'button';
  chalBtn.addEventListener('click', () => toggleModal(chalModal));

  const msnBtn = h('button', 'sfb-btn', 'Moon mission');
  msnBtn.type = 'button';
  msnBtn.title = 'Fly the Chandrayaan-3 / LVM3-M4 mission';
  msnBtn.addEventListener('click', () => cb.onMission?.());

  const padBtn = h('button', 'sfb-btn sfb-btn-primary sfb-b-pad-btn', 'Launch it ▸');
  padBtn.type = 'button';
  padBtn.title = 'Take this rocket to the launch pad';
  padBtn.addEventListener('click', () => cb.onGoToPad());

  topActions.append(undoBtn, redoBtn, filesBtn, exportBtn, chalBtn, msnBtn, padBtn);

  // ===== Floating view bar (bottom centre): everything a trackpad cannot do easily =====
  const viewBar = h('div', 'sfb-panel sfb-b-viewbar');
  const zoomOutBtn = h('button', 'sfb-btn sfb-b-view-icon', '−');
  zoomOutBtn.type = 'button';
  zoomOutBtn.title = 'Zoom out (−)';
  zoomOutBtn.setAttribute('aria-label', 'Zoom out');
  zoomOutBtn.addEventListener('click', () => cb.onZoom?.(1.25));
  const zoomInBtn = h('button', 'sfb-btn sfb-b-view-icon', '+');
  zoomInBtn.type = 'button';
  zoomInBtn.title = 'Zoom in (+)';
  zoomInBtn.setAttribute('aria-label', 'Zoom in');
  zoomInBtn.addEventListener('click', () => cb.onZoom?.(0.8));

  let mirrorOn = false;
  const mirrorBtn = h('button', 'sfb-btn', 'Mirror');
  mirrorBtn.type = 'button';
  mirrorBtn.title =
    'Mirror (M): side parts like fins go on as a matching left-and-right pair. Also mirrors the selected fins.';
  setPressed(mirrorBtn, false);
  mirrorBtn.addEventListener('click', () => {
    mirrorOn = !mirrorOn;
    setPressed(mirrorBtn, mirrorOn);
    cb.onToggleMirror?.(mirrorOn);
  });

  const viewHint = h('span', 'sfb-b-view-hint', 'Drag a part to move it · drag empty space to turn');
  viewBar.append(zoomOutBtn, zoomInBtn, fitBtn, cutawayBtn, mirrorBtn, viewHint);

  // Label that follows the pointer while a part is being dragged.
  const dragGhost = h('div', 'sfb-b-drag-ghost sfb-hidden');
  topBar.append(nameInput, statsEl, topActions);

  // ===== Left panel: Parts Palette =====
  // Search on top, category rail down the side, part cards on the right. Cards can be
  // clicked (adds at the obvious spot, or shows where it can go) or dragged onto the rocket.
  const palettePanel = h('aside', 'sfb-panel sfb-b-palette');

  const friendlyCache = new Map<string, FriendlyPart>();
  const friendlyOf = (preset: PartPreset): FriendlyPart => {
    let f = friendlyCache.get(preset.presetId);
    if (!f) {
      f = friendlyPart(preset);
      friendlyCache.set(preset.presetId, f);
    }
    return f;
  };

  const searchWrap = h('div', 'sfb-b-search');
  const searchInput = h('input', 'sfb-input sfb-b-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search parts…';
  searchInput.setAttribute('aria-label', 'Search parts');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  let searchQuery = '';
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    renderPalette();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchQuery = '';
      searchInput.blur();
      renderPalette();
    }
  });
  searchWrap.append(searchInput);

  let activeCat: PartCategory | 'all' = 'all';
  const catBar = h('div', 'sfb-b-cats');
  catBar.setAttribute('role', 'tablist');
  const catButtons = new Map<PartCategory | 'all', HTMLButtonElement>();

  const addCatBtn = (key: PartCategory | 'all', label: string, help: string): void => {
    const btn = h('button', 'sfb-b-cat');
    btn.type = 'button';
    btn.title = help;
    btn.setAttribute('role', 'tab');
    const ico = h('span', 'sfb-b-cat-ico');
    ico.innerHTML = iconSvg(key, 18);
    btn.append(ico, h('span', 'sfb-b-cat-label', label));
    btn.addEventListener('click', () => {
      activeCat = key;
      partList.scrollTop = 0;
      renderPalette();
    });
    catButtons.set(key, btn);
    catBar.append(btn);
  };
  addCatBtn('all', 'All', 'Every part');
  for (const c of PART_CATEGORIES) addCatBtn(c, FRIENDLY_CATEGORY[c], CATEGORY_HELP[c]);

  // "Fits my rocket": hide parts that are the wrong width for what is already built.
  let fitsOnly = true;
  try {
    fitsOnly = globalThis.localStorage?.getItem(FITS_KEY) !== '0';
  } catch {
    /* ignore */
  }
  let fitsFn: ((preset: PartPreset) => boolean) | null = null;
  // presetId -> fits, valid for the current rocket signature (cleared in render()).
  const fitCache = new Map<string, boolean>();
  const fitsBtn = h('button', 'sfb-b-fits');
  fitsBtn.type = 'button';
  fitsBtn.title = 'Only show parts that are the right width for your rocket';
  fitsBtn.setAttribute('role', 'switch');
  fitsBtn.append(h('span', 'sfb-b-fits-box'), h('span', '', 'Only parts that fit'));
  const setFitsOnly = (on: boolean): void => {
    fitsOnly = on;
    try {
      globalThis.localStorage?.setItem(FITS_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    renderPalette();
  };
  fitsBtn.addEventListener('click', () => setFitsOnly(!fitsOnly));

  const partList = h('div', 'sfb-b-part-list');
  const paletteNote = h('div', 'sfb-b-pal-note sfb-hidden');
  let activePlacingId: string | null = null;
  let suppressCardClick = false;

  function isOverStage(clientX: number, clientY: number): boolean {
    const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(clientX, clientY) : null;
    return !(el && el.closest('.sfb-panel, .sfb-b-modal-backdrop, .auth-chip'));
  }

  /** Mouse / trackpad drag of a card onto the rocket. Touch keeps tap-to-place. */
  function armCardDrag(preset: PartPreset, down: PointerEvent): void {
    const startX = down.clientX;
    const startY = down.clientY;
    let dragging = false;
    const name = friendlyOf(preset).name;

    const onMove = (e: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_START_PX) return;
        dragging = true;
        root.classList.add('is-dragging-part');
        cb.onDragStartPreset(preset);
      }
      const over = isOverStage(e.clientX, e.clientY);
      setDragGhost(over ? `Add ${name}` : name, e.clientX, e.clientY);
      cb.onDragMovePreset?.(e.clientX, e.clientY, over);
    };
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      root.classList.remove('is-dragging-part');
      setDragGhost(null);
    };
    const onUp = (e: PointerEvent): void => {
      finish();
      if (!dragging) return;
      // The browser still sends a click to the card after the drag; ignore that one.
      suppressCardClick = true;
      setTimeout(() => {
        suppressCardClick = false;
      }, 0);
      if (cb.onDropPreset) cb.onDropPreset(e.clientX, e.clientY, isOverStage(e.clientX, e.clientY));
      else cb.onDragEndPreset();
    };
    const onCancel = (): void => {
      finish();
      if (dragging) cb.onDragEndPreset();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  function makeCard(preset: PartPreset, fits: boolean): HTMLButtonElement {
    const f = friendlyOf(preset);
    const card = h(
      'button',
      `sfb-b-part-card${activePlacingId === preset.presetId ? ' is-placing' : ''}${fits ? '' : ' is-misfit'}`,
    );
    card.type = 'button';
    card.dataset.presetId = preset.presetId;
    card.title = `${preset.label} — ${preset.subtitle}\n${
      fits ? 'Click to add it, or drag it onto the rocket.' : 'Wrong width for this rocket: it will need an adapter.'
    }`;
    const ico = h('span', 'sfb-b-part-ico');
    ico.innerHTML = partThumbSvg(preset, 26);
    const text = h('span', 'sfb-b-part-text');
    text.append(h('span', 'sfb-b-part-name', f.name), h('span', 'sfb-b-part-sub', f.detail));
    card.append(ico, text);
    if (f.size) {
      const badge = h('span', 'sfb-b-part-size', f.size);
      badge.title = preset.diameterMm ? `${preset.diameterMm} mm wide` : '';
      card.append(badge);
    }
    card.addEventListener('click', () => {
      if (suppressCardClick) return;
      if (activePlacingId === preset.presetId) {
        cb.onCancelPlace();
      } else {
        setMobileDrawer('none');
        cb.onStartPlace(preset);
      }
    });
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      armCardDrag(preset, e);
    });
    // The pointer drag above replaces the browser's own drag-and-drop.
    card.addEventListener('dragstart', (e) => e.preventDefault());
    return card;
  }

  function renderPalette(): void {
    for (const [k, btn] of catButtons) {
      btn.classList.toggle('is-active', k === activeCat);
      btn.setAttribute('aria-selected', String(k === activeCat));
    }
    fitsBtn.classList.toggle('is-on', fitsOnly);
    fitsBtn.setAttribute('aria-checked', String(fitsOnly));

    const keepScroll = partList.scrollTop;
    partList.textContent = '';

    // Typing a search looks through every category, not just the open one.
    const inCat = PART_PRESETS.filter(
      (p) =>
        (searchQuery !== '' || activeCat === 'all' || p.category === activeCat) &&
        matchesSearch(friendlyOf(p), searchQuery),
    );
    const fitMap = new Map<string, boolean>();
    for (const p of inCat) {
      let fit = true;
      if (fitsFn) {
        const cached = fitCache.get(p.presetId);
        fit = cached ?? fitsFn(p);
        if (cached === undefined) fitCache.set(p.presetId, fit);
      }
      fitMap.set(p.presetId, fit);
    }
    const shown = fitsOnly ? inCat.filter((p) => fitMap.get(p.presetId)) : inCat;
    const hiddenByFit = inCat.length - shown.length;

    const grouped = searchQuery !== '' || activeCat === 'all';
    let lastCat: PartCategory | null = null;
    for (const preset of shown) {
      if (grouped && preset.category !== lastCat) {
        lastCat = preset.category;
        partList.append(h('div', 'sfb-b-part-group', CATEGORY_HELP[preset.category].split(' — ')[0]));
      }
      partList.append(makeCard(preset, fitMap.get(preset.presetId) ?? true));
    }

    if (shown.length === 0) {
      const empty = h('div', 'sfb-b-pal-empty');
      empty.append(
        h(
          'p',
          'sfb-hint',
          searchQuery
            ? `Nothing found for "${searchQuery}".`
            : hiddenByFit > 0
              ? 'Nothing here is the right width for your rocket yet.'
              : 'No parts here.',
        ),
      );
      if (searchQuery) {
        const clear = h('button', 'sfb-btn sfb-b-mini-btn', 'Clear search');
        clear.type = 'button';
        clear.addEventListener('click', () => {
          searchInput.value = '';
          searchQuery = '';
          renderPalette();
        });
        empty.append(clear);
      }
      partList.append(empty);
    }

    paletteNote.textContent = '';
    paletteNote.classList.toggle('sfb-hidden', hiddenByFit === 0);
    if (hiddenByFit > 0) {
      const showAll = h('button', 'sfb-b-link', 'Show them');
      showAll.type = 'button';
      showAll.addEventListener('click', () => setFitsOnly(false));
      paletteNote.append(
        h('span', '', `${hiddenByFit} more ${hiddenByFit === 1 ? 'part is' : 'parts are'} the wrong width. `),
        showAll,
      );
    }
    partList.scrollTop = keepScroll;
  }
  renderPalette();

  const palBody = h('div', 'sfb-b-pal-body');
  const palMain = h('div', 'sfb-b-pal-main');
  palMain.append(fitsBtn, partList, paletteNote);
  palBody.append(catBar, palMain);
  palettePanel.append(searchWrap, palBody);

  // ===== Floating snap placement / transition banner =====
  const snapBanner = h('div', 'sfb-panel sfb-b-snap-banner sfb-hidden');

  // ===== Right panel: Rocket Stack + Part Inspector + Live Flaws =====
  const rightPanel = h('aside', 'sfb-panel sfb-b-right');

  const stackHead = h('div', 'sfb-b-stack-head');
  stackHead.append(h('h2', 'sfb-section-title', 'Your rocket'));
  const stackHeadBtns = h('div', 'sfb-b-insp-actions');
  const mFilesBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-mobile-only', 'Save/Open');
  mFilesBtn.type = 'button';
  mFilesBtn.addEventListener('click', () => toggleFilesModal());
  const mExportBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-mobile-only', 'Export');
  mExportBtn.type = 'button';
  mExportBtn.addEventListener('click', () => openFilesModal(true));
  // The top bar's Challenges button is hidden on phones; this one sits in the Edit drawer.
  const mChalBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-mobile-only', 'Challenges');
  mChalBtn.type = 'button';
  mChalBtn.addEventListener('click', () => toggleModal(chalModal));
  const clearBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Start over');
  clearBtn.type = 'button';
  clearBtn.title = 'Remove every part (Undo brings them back)';
  clearBtn.addEventListener('click', () => cb.onClear());
  stackHeadBtns.append(mFilesBtn, mExportBtn, mChalBtn, clearBtn);
  stackHead.append(stackHeadBtns);

  const stackList = h('ul', 'sfb-b-stack');
  const stackEmpty = h('p', 'sfb-hint', 'Nothing here yet. Click a nose cone on the left, or drag one onto the stage.');
  const stackHint = h('p', 'sfb-b-stack-hint', 'Top to bottom. Click a part to change it; drag ⋮⋮ to reorder.');

  const inspectorWrap = h('div', 'sfb-b-inspector sfb-hidden');

  const flawsWrap = h('div', 'sfb-b-flaws sfb-hidden');

  rightPanel.append(stackHead, mNameInput, stackHint, stackEmpty, stackList, inspectorWrap, flawsWrap);

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
  const mCutawayBtn = h('button', 'sfb-btn', 'Inside');
  mCutawayBtn.type = 'button';
  setPressed(mCutawayBtn, false);
  function showCutaway(on: boolean): void {
    cutawayOn = on;
    setPressed(cutawayBtn, on);
    setPressed(mCutawayBtn, on);
  }
  const mPadBtn = h('button', 'sfb-btn sfb-btn-primary', 'Launch');
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
    showCutaway(!cutawayOn);
    cb.onToggleCutaway(cutawayOn);
  });
  mPadBtn.addEventListener('click', () => cb.onGoToPad());

  mobileBar.append(mPartsBtn, mStackBtn, mUndoBtn, mRedoBtn, mCutawayBtn, mPadBtn);

  // ===== Save / Load / Export modal =====
  const filesModal = h('div', 'sfb-b-modal-backdrop sfb-hidden');
  const filesCard = h('section', 'sfb-panel sfb-b-modal');
  const filesHead = h('div', 'sfb-b-stack-head');
  filesHead.append(h('h2', 'sfb-section-title', 'Save / open a rocket'));
  const filesClose = h('button', 'sfb-btn sfb-b-mini-btn', 'Close');
  filesClose.type = 'button';
  filesClose.addEventListener('click', () => closeModal(filesModal));
  filesHead.append(filesClose);

  const importInput = h('input', 'sfb-hidden');
  importInput.type = 'file';
  importInput.accept = IMPORT_ACCEPT;
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (file) {
      closeModal(filesModal);
      cb.onImportFile(file);
    }
  });

  const fileActions = h('div', 'sfb-b-file-actions');
  const saveBtn = h('button', 'sfb-btn sfb-btn-primary', 'Save this rocket');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => cb.onSaveDesign());

  const impBtn = h('button', 'sfb-btn', 'Import (.ork / .rkt / .json / .eng)…');
  impBtn.type = 'button';
  impBtn.title = 'Import OpenRocket (.ork), RockSim (.rkt), Astra (.json), or motor (.eng / .rse) file';
  impBtn.addEventListener('click', () => importInput.click());

  fileActions.append(saveBtn, impBtn, importInput);

  const exportSection = h('div', 'sfb-b-export-section');
  const exportHead = h('div', 'sfb-b-export-head');
  exportHead.append(h('h3', 'sfb-section-title', 'Export & Share'));
  const shareBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-share-btn', 'Copy share link');
  shareBtn.type = 'button';
  shareBtn.title = 'Copy a shareable link to this rocket';
  shareBtn.addEventListener('click', () => cb.onCopyShareLink());
  exportHead.append(shareBtn);

  const exportGrid = h('div', 'sfb-b-export-grid');
  for (const fmt of EXPORT_FORMATS) {
    const btn = h('button', 'sfb-btn sfb-b-export-btn');
    btn.type = 'button';
    btn.dataset.exportFormat = fmt.id;
    btn.title = fmt.description;
    btn.append(
      h('span', 'sfb-b-export-label', fmt.label),
      h('span', 'sfb-b-export-desc', fmt.description),
    );
    btn.addEventListener('click', () => cb.onExport(fmt.id));
    exportGrid.append(btn);
  }
  exportSection.append(exportHead, exportGrid);

  const savedGrid = h('div', 'sfb-b-saved-grid');
  const savedEmpty = h('p', 'sfb-hint', 'No saved rockets yet. Click "Save this rocket" to keep this one.');

  filesCard.append(filesHead, fileActions, exportSection, savedEmpty, savedGrid);
  filesModal.append(filesCard);
  filesModal.addEventListener('click', (e) => {
    if (e.target === filesModal) closeModal(filesModal);
  });

  function openFilesModal(scrollToExport = false): void {
    openModal(filesModal);
    if (scrollToExport) {
      exportSection.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }

  function toggleFilesModal(): void {
    toggleModal(filesModal);
  }

  let savedList: SavedDesign[] = [];
  /** The saved rocket whose card is asking "Delete?". Deleting also removes the cloud copy. */
  let pendingDeleteId: string | null = null;

  /** Show or drop the question on card `id`, and focus one of that card's buttons. */
  function askDelete(id: string, asking: boolean): void {
    pendingDeleteId = asking ? id : null;
    renderSavedDesigns(savedList);
    focusSavedButton(id, asking ? 'no' : 'delete');
  }

  function focusSavedButton(id: string, action: string): void {
    const card = Array.from(savedGrid.querySelectorAll<HTMLElement>('.sfb-b-saved-card'))
      .find((c) => c.dataset.designId === id);
    card?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.focus();
  }

  function renderSavedDesigns(list: SavedDesign[]): void {
    savedList = list;
    // A redraw while a card button has focus must not drop the keyboard back to the page.
    const focused = document.activeElement;
    const held = focused instanceof HTMLElement && savedGrid.contains(focused) ? focused : null;
    const heldId = held?.closest<HTMLElement>('.sfb-b-saved-card')?.dataset.designId;
    const heldAction = held?.dataset.action;
    savedGrid.textContent = '';
    savedEmpty.classList.toggle('sfb-hidden', list.length > 0);
    for (const item of list) {
      const card = h('div', 'sfb-b-saved-card');
      card.dataset.designId = item.id;
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
      openBtn.dataset.action = 'open';
      openBtn.addEventListener('click', () => {
        closeModal(filesModal);
        cb.onLoadSavedDesign(item.design);
      });
      const delBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-warn-btn', 'Delete');
      delBtn.type = 'button';
      delBtn.dataset.action = 'delete';
      delBtn.addEventListener('click', () => askDelete(item.id, true));
      if (pendingDeleteId === item.id) {
        const yesBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-warn-btn', 'Yes');
        yesBtn.type = 'button';
        yesBtn.dataset.action = 'yes';
        yesBtn.setAttribute('aria-label', `Yes, delete ${item.name}`);
        yesBtn.addEventListener('click', () => {
          pendingDeleteId = null;
          cb.onDeleteSavedDesign(item.id);
          // The app usually redraws the list; if it did not, drop the question here.
          if (yesBtn.isConnected) renderSavedDesigns(savedList);
          filesClose.focus();
        });
        const noBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'No');
        noBtn.type = 'button';
        noBtn.dataset.action = 'no';
        noBtn.setAttribute('aria-label', `No, keep ${item.name}`);
        noBtn.addEventListener('click', () => askDelete(item.id, false));
        row.append(h('span', 'sfb-b-saved-ask', 'Delete?'), yesBtn, noBtn);
      } else {
        row.append(openBtn, delBtn);
      }
      card.append(meta, row);
      savedGrid.append(card);
    }
    if (heldId && heldAction) focusSavedButton(heldId, heldAction);
  }

  // ===== Challenges modal =====
  const chalModal = h('div', 'sfb-b-modal-backdrop sfb-hidden');
  const chalCard = h('section', 'sfb-panel sfb-b-modal');
  const chalHead = h('div', 'sfb-b-stack-head');
  chalHead.append(h('h2', 'sfb-section-title', 'Challenges'));
  const chalClose = h('button', 'sfb-btn sfb-b-mini-btn', 'Close');
  chalClose.type = 'button';
  chalClose.addEventListener('click', () => closeModal(chalModal));
  chalHead.append(chalClose);
  const chalList = h('ul', 'sfb-b-chal-list');
  chalCard.append(chalHead, chalList);
  chalModal.append(chalCard);
  chalModal.addEventListener('click', (e) => {
    if (e.target === chalModal) closeModal(chalModal);
  });

  // ===== Modal state: dialog semantics, focus in and back out =====
  const dialogs = [
    { backdrop: filesModal, card: filesCard, head: filesHead, close: filesClose, titleId: 'sfb-b-files-title' },
    { backdrop: chalModal, card: chalCard, head: chalHead, close: chalClose, titleId: 'sfb-b-chal-title' },
  ];
  for (const d of dialogs) {
    d.card.setAttribute('role', 'dialog');
    d.card.setAttribute('aria-modal', 'true');
    const heading = d.head.querySelector('h2');
    if (heading) {
      heading.id = d.titleId;
      d.card.setAttribute('aria-labelledby', d.titleId);
    }
  }
  /** What had focus when the modal opened. */
  let modalReturnFocus: HTMLElement | null = null;

  function openedModal(): HTMLElement | null {
    return dialogs.find((d) => !d.backdrop.classList.contains('sfb-hidden'))?.backdrop ?? null;
  }

  function openModal(backdrop: HTMLElement): void {
    if (!backdrop.classList.contains('sfb-hidden')) return;
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backdrop.classList.remove('sfb-hidden');
    dialogs.find((d) => d.backdrop === backdrop)?.close.focus();
  }

  function closeModal(backdrop: HTMLElement, restoreFocus = true): void {
    if (backdrop.classList.contains('sfb-hidden')) return;
    backdrop.classList.add('sfb-hidden');
    if (backdrop === filesModal && pendingDeleteId !== null) {
      pendingDeleteId = null;
      renderSavedDesigns(savedList);
    }
    if (restoreFocus && modalReturnFocus?.isConnected) modalReturnFocus.focus();
    modalReturnFocus = null;
  }

  function toggleModal(backdrop: HTMLElement): void {
    if (backdrop.classList.contains('sfb-hidden')) openModal(backdrop);
    else closeModal(backdrop);
  }

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
    h('h3', 'sfb-section-title', 'How to build'),
    h('p', 'sfb-hint', '1. Drag a part from the left onto the rocket and let go — it snaps to the nearest glowing ring. Or just click a part.'),
    h('p', 'sfb-hint', '2. Click any part of the rocket to resize or recolour it. Drag it up or down to move it.'),
    h('p', 'sfb-hint', '3. Keep "Flies straight?" green, then press Launch it.'),
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

  const dropOverlay = h('div', 'sfb-drop sfb-b-drop', 'Drop .ork / .rkt / .json / .eng to import');
  let fileDragDepth = 0;
  const isExternalFileDrag = (e: DragEvent): boolean =>
    !root.classList.contains('sfb-hidden') &&
    Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    fileDragDepth++;
    root.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (fileDragDepth === 0) return;
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) root.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    fileDragDepth = 0;
    root.classList.remove('is-dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) cb.onImportFile(file);
  });

  root.append(topBar, snapBanner, palettePanel, rightPanel, viewBar, mobileBar, tutorial, dragGhost, filesModal, chalModal, dropOverlay);
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
    // An open modal owns the keyboard: Escape closes it, nothing reaches the rocket behind it.
    const modal = openedModal();
    if (modal) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal(modal);
      }
      return;
    }
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
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      searchInput.focus();
    } else if (e.key === 'm' || e.key === 'M') {
      mirrorBtn.click();
    } else if (e.key === '+' || e.key === '=') {
      cb.onZoom?.(0.8);
    } else if (e.key === '-' || e.key === '_') {
      cb.onZoom?.(1.25);
    }
  });

  function setDragGhost(text: string | null, clientX?: number, clientY?: number): void {
    if (text === null) {
      dragGhost.classList.add('sfb-hidden');
      return;
    }
    dragGhost.textContent = text;
    dragGhost.classList.remove('sfb-hidden');
    if (clientX !== undefined && clientY !== undefined) {
      dragGhost.style.transform = `translate(${Math.round(clientX + 14)}px, ${Math.round(clientY + 16)}px)`;
    }
  }

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
      if (!Number.isFinite(v)) {
        num.value = parseFloat(range.value).toFixed(digits);
        return;
      }
      // Typing may pass the slider's end, but not by an absurd amount.
      const clamped = Math.min(Math.max(opts.min, v), Math.max(opts.max * 10, opts.value));
      if (clamped !== v) num.value = clamped.toFixed(digits);
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
      label: 'Made of',
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
        label: 'Measure from',
        value: anchor,
        options: [
          { value: 'top', label: 'Top of tube' },
          { value: 'middle', label: 'Middle of tube' },
          { value: 'bottom', label: 'Bottom of tube' },
        ],
        onChange: (v) => cb.onUpdatePart(partId, { anchor: v as AnchorMode }, true),
      }),
      sliderControl({
        label: 'Slide up / down',
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
  let lastPaletteSig = '';
  let lastScrolledSelection: string | null = null;

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
    head.append(h('h3', 'sfb-section-title', `Edit: ${friendlyName(part.name)}`));

    const acts = h('div', 'sfb-b-insp-actions');
    if (found.parentId === null) {
      const upBtn = h('button', 'sfb-btn sfb-b-mini-btn', '▲ Up');
      upBtn.type = 'button';
      upBtn.title = 'Move this part up the rocket';
      upBtn.disabled = found.stackIndex <= 0;
      upBtn.addEventListener('click', () => cb.onMovePart(part.id, -1));

      const dnBtn = h('button', 'sfb-btn sfb-b-mini-btn', '▼ Down');
      dnBtn.type = 'button';
      dnBtn.title = 'Move this part down the rocket';
      dnBtn.disabled = found.stackIndex >= design.stack.length - 1;
      dnBtn.addEventListener('click', () => cb.onMovePart(part.id, 1));
      acts.append(upBtn, dnBtn);
    } else {
      const curOffset = found.offset ?? 0;
      const foreBtn = h('button', 'sfb-btn sfb-b-mini-btn', '▲ Up');
      foreBtn.type = 'button';
      foreBtn.title = 'Slide 2 cm up the tube';
      foreBtn.addEventListener('click', () => {
        lastInspectorKey = '';
        cb.onUpdatePart(part.id, { offset: Math.max(-0.3, Number((curOffset - 0.02).toFixed(4))) }, true);
      });

      const aftBtn = h('button', 'sfb-btn sfb-b-mini-btn', '▼ Down');
      aftBtn.type = 'button';
      aftBtn.title = 'Slide 2 cm down the tube';
      aftBtn.addEventListener('click', () => {
        lastInspectorKey = '';
        cb.onUpdatePart(part.id, { offset: Math.min(0.3, Number((curOffset + 0.02).toFixed(4))) }, true);
      });
      acts.append(foreBtn, aftBtn);
    }

    const dupBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Copy');
    dupBtn.type = 'button';
    dupBtn.title = 'Make a copy (Ctrl+D)';
    dupBtn.addEventListener('click', () => cb.onDuplicatePart(part.id));

    const delBtn = h('button', 'sfb-btn sfb-b-mini-btn sfb-b-warn-btn', 'Delete');
    delBtn.type = 'button';
    delBtn.title = 'Remove this part (Del)';
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
            label: 'Width',
            unit: 'mm',
            value: nc.baseRadius * 2000,
            min: 10,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ baseRadius: mm / 2000 } as Partial<NoseCone>, commit),
          }),
          sliderControl({
            label: 'Wall thickness',
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
            label: 'Width',
            unit: 'mm',
            value: bt.outerRadius * 2000,
            min: 12,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ outerRadius: mm / 2000 } as Partial<BodyTube>, commit),
          }),
          sliderControl({
            label: 'Wall thickness',
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
            label: 'Top width',
            unit: 'mm',
            value: tr.foreRadius * 2000,
            min: 10,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ foreRadius: mm / 2000 } as Partial<Transition>, commit),
          }),
          sliderControl({
            label: 'Bottom width',
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
        const flipBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Flip upside down');
        flipBtn.type = 'button';
        flipBtn.title = 'Swap the wide end and the narrow end';
        flipBtn.addEventListener('click', () => {
          lastInspectorKey = '';
          patch({ foreRadius: tr.aftRadius, aftRadius: tr.foreRadius } as Partial<Transition>, true);
        });
        fields.append(flipBtn);
        break;
      }

      case 'finset': {
        const fn = part as FinSet;
        // Quick symmetry buttons for 3 / 4 / 6 fins + full count slider
        const symRow = h('div', 'sfb-b-sym-row');
        symRow.append(h('span', 'sfb-b-ctrl-label', 'How many fins'));
        const symBtns = h('div', 'sfb-b-sym-btns');
        for (const n of [2, 3, 4, 5, 6]) {
          const b = h('button', `sfb-btn sfb-b-mini-btn${fn.count === n ? ' is-active' : ''}`, `${n}×`);
          b.type = 'button';
          b.title = n === 2 ? 'Mirrored pair: one fin left, one fin right' : `${n} fins spaced evenly around the body`;
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
            label: 'Fin shape',
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
            label: 'Length at the body',
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
                  label: 'Length at the tip',
                  unit: 'mm',
                  value: fn.tipChord * 1000,
                  min: 0,
                  max: 200,
                  step: 1,
                  digits: 0,
                  onChange: (mm, commit) => patch({ tipChord: mm / 1000 } as Partial<FinSet>, commit),
                }),
                sliderControl({
                  label: 'Lean back',
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
            label: 'Sticks out',
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
          symRow.append(h('span', 'sfb-b-ctrl-label', 'How many boosters'));
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
          { value: '', label: 'No engine (empty holder)' },
          ...motors.map((m) => ({
            value: motorKey(m),
            label: `${motorKey(m)} (${(m.diameter * 1000).toFixed(0)}mm · ${Math.round(m.totalImpulse)} N·s)`,
          })),
        ];
        fields.append(
          selectControl({
            label: 'Engine',
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
            label: 'Wait before parachute pops',
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
            label: 'Width',
            unit: 'mm',
            value: it.outerRadius * 2000,
            min: 10,
            max: 80,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ outerRadius: mm / 2000 } as Partial<InnerTube>, commit),
          }),
          sliderControl({
            label: 'Holder length',
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
            label: 'Parachute size',
            unit: 'cm',
            value: ch.diameter * 100,
            min: 10,
            max: 180,
            step: 2,
            digits: 0,
            onChange: (cm, commit) => patch({ diameter: cm / 100 } as Partial<Parachute>, commit),
          }),
          sliderControl({
            label: 'Braking strength',
            unit: '—',
            value: ch.cd,
            min: 0.4,
            max: 1.5,
            step: 0.05,
            digits: 2,
            onChange: (v, commit) => patch({ cd: v } as Partial<Parachute>, commit),
          }),
          selectControl({
            label: 'Opens when',
            value: ch.deployEvent,
            options: [
              { value: 'ejection', label: 'The engine pops it out' },
              { value: 'apogee', label: 'At the highest point' },
              { value: 'altitude', label: 'On the way down, at a set height' },
            ],
            onChange: (v) => {
              lastInspectorKey = '';
              patch({ deployEvent: v as Parachute['deployEvent'] } as Partial<Parachute>, true);
            },
          }),
          ...(ch.deployEvent === 'altitude'
            ? [
                sliderControl({
                  label: 'Open at height',
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
            label: 'Width',
            unit: 'mm',
            value: rg.outerRadius * 2000,
            min: 4,
            max: 120,
            step: 0.5,
            digits: 1,
            onChange: (mm, commit) => patch({ outerRadius: mm / 2000 } as Partial<Ring>, commit),
          }),
          sliderControl({
            label: 'Hole width',
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
    flawsWrap.append(h('h3', 'sfb-section-title', `Things to fix (${flaws.length})`));
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

    if (document.activeElement !== mNameInput) mNameInput.value = design.name;
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
      sStab.val.textContent = `${stabilityWord(stats.stabilityCal)} · ${stats.stabilityCal.toFixed(1)}`;
      sStab.val.className = `sfb-b-stat-v ${stabilityClass(stats.stabilityCal)}`;
    } else {
      sStab.val.textContent = '—';
      sStab.val.className = 'sfb-b-stat-v';
    }
    if (stats.twr !== null && Number.isFinite(stats.twr)) {
      sTwr.val.textContent = `${stats.twr < 5 ? 'Too weak' : 'Good'} · ${stats.twr.toFixed(stats.twr < 10 ? 1 : 0)}× weight`;
      sTwr.val.className = `sfb-b-stat-v ${stats.twr < 5 ? 'sfb-stab-critical' : 'sfb-stab-good'}`;
    } else {
      sTwr.val.textContent = stats.length > 0 ? 'No engine' : '—';
      sTwr.val.className = `sfb-b-stat-v${stats.length > 0 ? ' sfb-stab-warning' : ''}`;
    }

    // The "fits my rocket" filter depends on the rocket's widths; redraw the palette
    // only when those change, not on every slider tick.
    fitsFn = state.fits ?? null;
    // computeSnapPoints decides diameterMatch / snap existence only from each stack part's
    // kind and fore/aft/inner radii (plus stack order and node ids); lengths, masses,
    // colours, names and children never affect it.
    const sig = design.stack
      .map((n) => `${n.id}:${n.part.kind}:${foreRadiusOf(n.part)}:${aftRadiusOf(n.part)}:${innerRadiusOf(n.part)}`)
      .join('|');
    if (sig !== lastPaletteSig) {
      lastPaletteSig = sig;
      fitCache.clear();
      renderPalette();
    }
    stackHint.classList.toggle('sfb-hidden', design.stack.length === 0);

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

    // A multi-stage rocket gets a heading where each stage begins.
    const startsStage = (n: (typeof design.stack)[number], i: number): boolean =>
      i === 0 || !!n.stage || (n.part.kind === 'bodytube' && !!n.part.isDecoupler);
    const stageTotal = design.stack.filter(startsStage).length;
    let stageNo = 0;

    for (let stackIdx = 0; stackIdx < design.stack.length; stackIdx++) {
      const node = design.stack[stackIdx];
      if (stageTotal > 1 && startsStage(node, stackIdx)) {
        stageNo++;
        const label = node.stage?.name || (stageNo === 1 ? 'Top stage' : `Booster ${stageNo - 1}`);
        const head = h('li', 'sfb-b-stage-head', `Stage ${stageNo} of ${stageTotal} · ${label}`);
        head.title = stageNo === 1 ? 'The part that flies highest.' : 'Drops away when its engine burns out.';
        stackList.append(head);
      }
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

      const labelBtn = h('button', 'sfb-b-stack-label', friendlyName(node.part.name));
      labelBtn.title = node.part.name;
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
          const clabel = h('button', 'sfb-b-stack-label', friendlyName(ch.part.name));
          clabel.title = ch.part.name;
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
    // On a short laptop screen the editor can sit below the fold: bring it up when the
    // selection changes (not on every redraw, which would fight the user's scrolling).
    if (selectedId !== lastScrolledSelection) {
      lastScrolledSelection = selectedId;
      if (selectedId && typeof inspectorWrap.scrollIntoView === 'function') {
        inspectorWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
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
        ? `Click a glowing ring to put the ${friendlyOf(preset).name} there`
        : `The ${friendlyOf(preset).name} cannot go on this rocket`,
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
      `This part is a different width (${prompt.snap.warning ?? ''}). Add an adapter so it fits?`,
    );
    const actions = h('div', 'sfb-b-snap-actions');
    const withTr = h('button', 'sfb-btn sfb-btn-primary sfb-b-mini-btn', 'Add with adapter');
    withTr.type = 'button';
    withTr.addEventListener('click', () => cb.onChooseSnap(prompt.snap, true));

    const plain = h('button', 'sfb-btn sfb-b-mini-btn', 'Add anyway');
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
      else {
        fileDragDepth = 0;
        root.classList.remove('is-dragging');
        setMobileDrawer('none');
        for (const d of dialogs) closeModal(d.backdrop, false);
      }
    },
    render,
    setPlacing,
    setTransitionPrompt,
    setCutaway(on: boolean) {
      showCutaway(on);
    },
    setMirror(on: boolean) {
      mirrorOn = on;
      setPressed(mirrorBtn, on);
    },
    setDragGhost,
  };
}
