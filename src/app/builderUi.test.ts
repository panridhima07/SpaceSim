// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBuilderUI, type BuilderUICallbacks } from './builderUi';
import { addExternalPart, addInternalPart, createEmptyDesign } from '../builder/design';
import { findPreset } from '../builder/parts';
import { ALL_MOTORS } from '../ork/motors';
import type { BodyTube, FinSet, NoseCone } from '../types';

function makeCallbacks(): BuilderUICallbacks {
  return {
    onStartPlace: vi.fn(),
    onCancelPlace: vi.fn(),
    onChooseSnap: vi.fn(),
    onDragStartPreset: vi.fn(),
    onDragEndPreset: vi.fn(),
    onSelectPart: vi.fn(),
    onUpdatePart: vi.fn(),
    onMovePart: vi.fn(),
    onDuplicatePart: vi.fn(),
    onDeletePart: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onRename: vi.fn(),
    onClear: vi.fn(),
    onToggleCutaway: vi.fn(),
    onFrameCamera: vi.fn(),
    onGoToPad: vi.fn(),
    onSaveDesign: vi.fn(),
    onLoadSavedDesign: vi.fn(),
    onDeleteSavedDesign: vi.fn(),
    onExportJson: vi.fn(),
    onExportOrk: vi.fn(),
    onImportFile: vi.fn(),
  };
}

describe('createBuilderUI', () => {
  let container: HTMLElement;
  let cb: BuilderUICallbacks;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.append(container);
    cb = makeCallbacks();
  });

  it('renders parts palette, filters categories, and starts placement on click', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);

    const cards = container.querySelectorAll<HTMLButtonElement>('.sfb-b-part-card');
    expect(cards.length).toBeGreaterThan(20);

    cards[0].click();
    expect(cb.onStartPlace).toHaveBeenCalledTimes(1);
  });

  it('renders stack, inspector controls, fin symmetry buttons, and colour swatches', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);

    let d = createEmptyDesign('Inspector Test');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    const t = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube);
    d = t.design;
    const f = addInternalPart(d, t.id, findPreset('fins-trap-3-bt50')!.create() as FinSet)!;
    d = f.design;

    bui.render({
      design: d,
      selectedId: f.id,
      stats: {
        length: 0.33,
        mass: 0.06,
        stabilityCal: 1.8,
        twr: 12,
        motorLabel: 'Estes C6',
        flaws: [],
      },
      canUndo: true,
      canRedo: false,
      motors: ALL_MOTORS,
      savedDesigns: [],
      completedChallenges: new Set(['c-class-300']),
      forceInspectorRefresh: true,
    });

    expect(container.querySelector('.sfb-b-inspector')!.classList.contains('sfb-hidden')).toBe(false);
    // Click 4x symmetry button
    const symBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('.sfb-b-sym-btns button'));
    const fourBtn = symBtns.find((b) => b.textContent === '4×')!;
    fourBtn.click();
    expect(cb.onUpdatePart).toHaveBeenCalledWith(f.id, { part: { count: 4 } }, true);

    // Click a colour swatch
    const swatches = container.querySelectorAll<HTMLButtonElement>('.sfb-b-swatch');
    expect(swatches.length).toBeGreaterThanOrEqual(6);
    swatches[2].click();
    expect(cb.onUpdatePart).toHaveBeenCalledTimes(2);
  });

  it('triggers Undo/Redo on Ctrl+Z and Ctrl+Y when visible', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(cb.onUndo).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    expect(cb.onRedo).toHaveBeenCalledTimes(1);
  });
});
