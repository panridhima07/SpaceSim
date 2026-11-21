// DOM UI for Build Mode (palette, stack list, top readout bar, Go to pad).
// Works in both desktop layout and .sfb-mobile phone layout (44px+ touch targets).

import type { Design } from '../builder/design';
import {
  CATEGORY_LABELS,
  PART_CATEGORIES,
  PART_PRESETS,
  type PartCategory,
  type PartPreset,
} from '../builder/parts';

export interface BuilderStats {
  length: number;
  mass: number;
  stabilityCal: number;
  twr: number | null;
  motorLabel: string | null;
}

export interface BuilderUICallbacks {
  onAddPreset(preset: PartPreset): void;
  onSelectPart(partId: string | null): void;
  onDeletePart(partId: string): void;
  onRename(name: string): void;
  onClear(): void;
  onToggleCutaway(on: boolean): void;
  onFrameCamera(): void;
  onGoToPad(): void;
}

export interface BuilderUI {
  readonly root: HTMLElement;
  setVisible(visible: boolean): void;
  render(design: Design, selectedId: string | null, stats: BuilderStats): void;
  setCutaway(on: boolean): void;
}

const MOBILE_QUERY = '(max-width: 760px), (max-height: 500px)';

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

export function createBuilderUI(container: HTMLElement, cb: BuilderUICallbacks): BuilderUI {
  const root = h('div', 'sfb-root sfb-builder sfb-hidden');

  // ===== Top bar: name, live engineering stats, Go to pad =====
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
  let cutawayOn = false;
  const cutawayBtn = h('button', 'sfb-btn', 'Cutaway');
  cutawayBtn.type = 'button';
  cutawayBtn.addEventListener('click', () => {
    cutawayOn = !cutawayOn;
    cutawayBtn.classList.toggle('is-active', cutawayOn);
    cb.onToggleCutaway(cutawayOn);
  });

  const fitBtn = h('button', 'sfb-btn', 'Fit');
  fitBtn.type = 'button';
  fitBtn.title = 'Frame rocket in view';
  fitBtn.addEventListener('click', () => cb.onFrameCamera());

  const padBtn = h('button', 'sfb-btn sfb-btn-primary sfb-b-pad-btn', 'Go to Pad');
  padBtn.type = 'button';
  padBtn.addEventListener('click', () => cb.onGoToPad());

  topActions.append(cutawayBtn, fitBtn, padBtn);
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

  function renderPalette(): void {
    for (const [k, btn] of catButtons) {
      btn.classList.toggle('is-active', k === activeCat);
    }
    partList.textContent = '';
    const items = activeCat === 'all' ? PART_PRESETS : PART_PRESETS.filter((p) => p.category === activeCat);
    for (const preset of items) {
      const card = h('button', 'sfb-b-part-card');
      card.type = 'button';
      card.dataset.presetId = preset.presetId;
      card.append(
        h('span', 'sfb-b-part-name', preset.label),
        h('span', 'sfb-b-part-sub', preset.subtitle),
      );
      card.addEventListener('click', () => cb.onAddPreset(preset));
      partList.append(card);
    }
  }
  renderPalette();
  palettePanel.append(catBar, partList);

  // ===== Right panel: Rocket Stack & Inspector =====
  const rightPanel = h('aside', 'sfb-panel sfb-b-right');
  const stackHead = h('div', 'sfb-b-stack-head');
  stackHead.append(h('h2', 'sfb-section-title', 'Rocket Stack'));
  const clearBtn = h('button', 'sfb-btn sfb-b-mini-btn', 'Clear');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => cb.onClear());
  stackHead.append(clearBtn);

  const stackList = h('ul', 'sfb-b-stack');
  const stackEmpty = h('p', 'sfb-hint', 'Tap a part in the palette to start building.');
  rightPanel.append(stackHead, stackEmpty, stackList);

  // ===== Mobile bottom bar to toggle Parts / Stack drawers =====
  const mobileBar = h('div', 'sfb-panel sfb-b-mobile-bar');
  let mobileDrawer: 'none' | 'parts' | 'stack' = 'none';

  const mPartsBtn = h('button', 'sfb-btn', 'Parts');
  mPartsBtn.type = 'button';
  const mStackBtn = h('button', 'sfb-btn', 'Stack');
  mStackBtn.type = 'button';
  const mCutawayBtn = h('button', 'sfb-btn', 'Cutaway');
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
  mCutawayBtn.addEventListener('click', () => {
    cutawayOn = !cutawayOn;
    cutawayBtn.classList.toggle('is-active', cutawayOn);
    mCutawayBtn.classList.toggle('is-active', cutawayOn);
    cb.onToggleCutaway(cutawayOn);
  });
  mPadBtn.addEventListener('click', () => cb.onGoToPad());

  mobileBar.append(mPartsBtn, mStackBtn, mCutawayBtn, mPadBtn);

  root.append(topBar, palettePanel, rightPanel, mobileBar);
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

  function render(design: Design, selectedId: string | null, stats: BuilderStats): void {
    if (document.activeElement !== nameInput) {
      nameInput.value = design.name;
    }

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

    for (const node of design.stack) {
      const li = h('li', 'sfb-b-stack-item');
      const row = h('div', `sfb-b-stack-row${node.id === selectedId ? ' is-selected' : ''}`);
      const labelBtn = h('button', 'sfb-b-stack-label', node.part.name);
      labelBtn.type = 'button';
      labelBtn.addEventListener('click', () => cb.onSelectPart(node.id));

      const delBtn = h('button', 'sfb-b-del', '×');
      delBtn.type = 'button';
      delBtn.title = `Remove ${node.part.name}`;
      delBtn.setAttribute('aria-label', `Remove ${node.part.name}`);
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onDeletePart(node.id);
      });

      row.append(labelBtn, delBtn);
      li.append(row);

      if (node.children.length > 0) {
        const sub = h('ul', 'sfb-b-sublist');
        for (const ch of node.children) {
          const cli = h('li', `sfb-b-stack-row sfb-b-child-row${ch.id === selectedId ? ' is-selected' : ''}`);
          const clabel = h('button', 'sfb-b-stack-label', ch.part.name);
          clabel.type = 'button';
          clabel.addEventListener('click', () => cb.onSelectPart(ch.id));

          const cdel = h('button', 'sfb-b-del', '×');
          cdel.type = 'button';
          cdel.title = `Remove ${ch.part.name}`;
          cdel.setAttribute('aria-label', `Remove ${ch.part.name}`);
          cdel.addEventListener('click', (e) => {
            e.stopPropagation();
            cb.onDeletePart(ch.id);
          });

          cli.append(clabel, cdel);
          sub.append(cli);
        }
        li.append(sub);
      }
      stackList.append(li);
    }
  }

  return {
    root,
    setVisible(visible: boolean) {
      root.classList.toggle('sfb-hidden', !visible);
      if (!visible) setMobileDrawer('none');
    },
    render,
    setCutaway(on: boolean) {
      cutawayOn = on;
      cutawayBtn.classList.toggle('is-active', on);
      mCutawayBtn.classList.toggle('is-active', on);
    },
  };
}
