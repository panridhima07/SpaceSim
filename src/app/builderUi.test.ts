// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBuilderUI, type BuilderUICallbacks } from './builderUi';
import { addExternalPart, addInternalPart, createEmptyDesign } from '../builder/design';
import { findPreset } from '../builder/parts';
import { EXPORT_FORMATS } from '../io/exporter';
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
    onExport: vi.fn(),
    onCopyShareLink: vi.fn(),
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

  it('recomputes palette fits only when a stack part radius changes, not its length', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);

    let d = createEmptyDesign('Fits Cache');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    d = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube).design;
    const fits = vi.fn(() => true);
    const stateFor = (design: typeof d) => ({
      design,
      selectedId: null,
      stats: { length: 0.33, mass: 0.06, stabilityCal: 1.8, twr: 12, motorLabel: 'Estes C6', flaws: [] },
      canUndo: false,
      canRedo: false,
      motors: ALL_MOTORS,
      savedDesigns: [],
      completedChallenges: new Set<string>(),
      fits,
    });

    bui.render(stateFor(d));
    const first = fits.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // Length-only change: no recompute.
    const longer = {
      ...d,
      stack: d.stack.map((n, i) => (i === 1 ? { ...n, part: { ...n.part, length: n.part.length + 0.1 } } : n)),
    };
    bui.render(stateFor(longer));
    expect(fits).toHaveBeenCalledTimes(first);

    // Radius change: recompute.
    const wider = {
      ...d,
      stack: d.stack.map((n, i) =>
        i === 1 ? { ...n, part: { ...n.part, outerRadius: (n.part as BodyTube).outerRadius + 0.01 } } : n,
      ),
    };
    bui.render(stateFor(wider));
    expect(fits.mock.calls.length).toBeGreaterThan(first);
  });

  it('triggers Undo/Redo on Ctrl+Z and Ctrl+Y when visible', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(cb.onUndo).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    expect(cb.onRedo).toHaveBeenCalledTimes(1);
  });

  const emptyState = (design = createEmptyDesign('Named')) => ({
    design,
    selectedId: null as string | null,
    stats: { length: 0, mass: 0, stabilityCal: 0, twr: null, motorLabel: null, flaws: [] },
    canUndo: false,
    canRedo: false,
    motors: ALL_MOTORS,
    savedDesigns: [{ id: 'one', name: 'Saved one', savedAt: 0, design }],
    completedChallenges: new Set<string>(),
  });
  const button = (text: string): HTMLButtonElement =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement;
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
  };

  it('treats its modals as dialogs: focus, Escape, and no shortcuts behind them', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);
    bui.render({ ...emptyState(), selectedId: 'some-part' });

    for (const opener of [button('Save / Open'), button('Challenges')]) {
      opener.focus();
      opener.click();
      const dialog = container.querySelector<HTMLElement>(
        '.sfb-b-modal-backdrop:not(.sfb-hidden) [role="dialog"]',
      ) as HTMLElement;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).not.toBeNull();
      expect(dialog.contains(document.activeElement)).toBe(true);

      press('Backspace');
      press('Delete');
      press('z', { ctrlKey: true });
      press('m');
      expect(cb.onDeletePart).not.toHaveBeenCalled();
      expect(cb.onUndo).not.toHaveBeenCalled();

      press('Escape');
      expect(container.querySelector('.sfb-b-modal-backdrop:not(.sfb-hidden)')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(cb.onSelectPart).not.toHaveBeenCalled();
    }

    press('Backspace');
    expect(cb.onDeletePart).toHaveBeenCalledWith('some-part');
  });

  it('asks before deleting a saved rocket', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);
    bui.render(emptyState());
    button('Save / Open').click();

    button('Delete').click();
    expect(cb.onDeleteSavedDesign).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('No'));
    // A redraw keeps the question and its focus.
    bui.render(emptyState());
    expect(document.activeElement).toBe(button('No'));
    button('No').click();
    expect(button('Yes')).toBeUndefined();
    expect(cb.onDeleteSavedDesign).not.toHaveBeenCalled();

    button('Delete').click();
    button('Yes').click();
    expect(cb.onDeleteSavedDesign).toHaveBeenCalledWith('one');

    // Closing the modal drops an unanswered question.
    button('Delete').click();
    press('Escape');
    expect(button('Yes')).toBeUndefined();
  });

  it('reports the cutaway and mirror state and offers a phone rename box', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);
    bui.render(emptyState());

    expect(button('Mirror').getAttribute('aria-pressed')).toBe('false');
    button('Mirror').click();
    expect(button('Mirror').getAttribute('aria-pressed')).toBe('true');
    bui.setMirror(false);
    expect(button('Mirror').getAttribute('aria-pressed')).toBe('false');

    button('Inside').click();
    expect(button('See inside').getAttribute('aria-pressed')).toBe('true');
    bui.setCutaway(false);
    expect(button('Inside').getAttribute('aria-pressed')).toBe('false');

    const name = container.querySelector<HTMLInputElement>('.sfb-b-mobile-name') as HTMLInputElement;
    expect(name.value).toBe('Named');
    name.value = '  Falcon  ';
    name.dispatchEvent(new Event('change'));
    expect(cb.onRename).toHaveBeenCalledWith('Falcon');
  });

  it('renders one export button per EXPORT_FORMATS entry and calls onExport / onCopyShareLink', () => {
    const bui = createBuilderUI(container, cb);
    bui.setVisible(true);

    const exportTopBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.sfb-b-top-actions button'),
    ).find((b) => b.textContent === 'Export');
    expect(exportTopBtn).toBeDefined();
    exportTopBtn!.click();

    const exportBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('.sfb-b-export-btn'));
    expect(exportBtns.length).toBe(EXPORT_FORMATS.length);

    for (let i = 0; i < EXPORT_FORMATS.length; i++) {
      const fmt = EXPORT_FORMATS[i];
      const btn = exportBtns[i];
      expect(btn.textContent).toContain(fmt.label);
      expect(btn.textContent).toContain(fmt.description);
      btn.click();
      expect(cb.onExport).toHaveBeenCalledWith(fmt.id);
    }

    const shareBtn = container.querySelector<HTMLButtonElement>('.sfb-b-share-btn');
    expect(shareBtn).not.toBeNull();
    shareBtn!.click();
    expect(cb.onCopyShareLink).toHaveBeenCalledTimes(1);
  });
});
