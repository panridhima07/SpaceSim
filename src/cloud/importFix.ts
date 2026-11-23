// "Fix my import": after a rocket file is opened, a small bar lets the person save the
// corrections they make in the builder. The same file then opens their way next time,
// on this device and (when signed in) on any other. With consent, the file and the
// correction also become a training record for our own importer.

import type { Design } from '../builder/design';
import type { RocketModel } from '../types';
import {
  deleteLocalCorrection,
  describeChanges,
  diffDesigns,
  loadLocalCorrection,
  makeCorrection,
  pickCorrection,
  saveLocalCorrection,
  sha256Hex,
} from './corrections';
import './importFix.css';
import type { Cloud } from './session';
import type { ImportCorrection } from './types';

export interface ImportFixHooks {
  /** The design in the builder right now. */
  getDesign(): Design | null;
  /** Replace the builder's rocket. */
  loadDesign(design: Design): void;
  toast(message: string): void;
}

export interface ImportFix {
  /** Call after a rocket file was imported and loaded. */
  afterImport(a: { bytes: Uint8Array; filename: string; format: string; parsedModel: RocketModel; imported: Design }): Promise<void>;
  /** SHA-256 of the file the current rocket came from, if any. */
  sourceSha(): string | undefined;
  /** The bar shows only while building. */
  setVisible(on: boolean): void;
  /** Forget the current file (a different rocket was loaded another way). */
  clear(): void;
}

interface Context {
  sha: string;
  filename: string;
  parsedModel: RocketModel;
  imported: Design;
  saved: ImportCorrection | null;
  showing: 'fixed' | 'original';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createImportFix(cloudReady: Promise<Cloud>, hooks: ImportFixHooks): ImportFix {
  const bar = el('div', 'sfb-fix-bar');
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Fix this import');
  document.body.append(bar);

  let ctx: Context | null = null;
  let visible = false;
  let dismissed = false;
  let noteOpen = false;

  const sync = (): void => {
    bar.hidden = !(ctx && visible && !dismissed);
  };

  const button = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const b = el('button', `sfb-fix-btn${primary ? ' is-primary' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  const render = (): void => {
    bar.textContent = '';
    if (!ctx) return sync();
    const c = ctx;
    const text = el('div', 'sfb-fix-text');
    const actions = el('div', 'sfb-fix-actions');

    if (noteOpen) {
      const changes = diffDesigns(c.imported, hooks.getDesign() ?? c.imported);
      const list = el('ul', 'sfb-fix-list');
      for (const line of describeChanges(changes, 4)) list.append(el('li', '', line));
      const note = el('input', 'sfb-fix-note');
      note.type = 'text';
      note.maxLength = 300;
      note.placeholder = 'What did we get wrong? (optional)';
      note.setAttribute('aria-label', 'What did we get wrong? Optional.');
      if (c.saved?.note) note.value = c.saved.note;
      text.append(el('strong', '', `Save ${changes.length} change${changes.length === 1 ? '' : 's'} as your fix for this file`), list, note);
      const save = (): void => void saveFix(note.value);
      note.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
      });
      actions.append(
        button('Save', true, save),
        button('Cancel', false, () => {
          noteOpen = false;
          render();
        }),
      );
      bar.append(text, actions);
      sync();
      note.focus();
      return;
    }

    if (c.saved && c.showing === 'fixed') {
      const n = c.saved.changes.length;
      text.append(
        el('strong', '', 'Opened with your saved fix'),
        el('span', '', ` · ${c.filename} · ${n} change${n === 1 ? '' : 's'}`),
      );
      actions.append(
        button('Update my fix', true, openNote),
        button('Show original', false, () => {
          c.showing = 'original';
          hooks.loadDesign(c.imported);
          render();
        }),
        button('Forget my fix', false, () => void forgetFix()),
      );
    } else if (c.saved) {
      text.append(el('strong', '', 'Showing the file as we imported it'), el('span', '', ` · ${c.filename}`));
      actions.append(
        button('Use my fix', true, () => {
          c.showing = 'fixed';
          hooks.loadDesign(c.saved!.correctedDesign);
          render();
        }),
      );
    } else {
      text.append(
        el('strong', '', 'Did we draw this right?'),
        el('span', '', ` If anything in ${c.filename} looks wrong, fix it here, then save your fix. The file will open your way next time.`),
      );
      actions.append(button('Save my fix', true, openNote));
    }
    const close = button('×', false, () => {
      dismissed = true;
      sync();
    });
    close.classList.add('sfb-fix-close');
    close.setAttribute('aria-label', 'Hide');
    actions.append(close);
    bar.append(text, actions);
    sync();
  };

  function openNote(): void {
    if (!ctx) return;
    const now = hooks.getDesign();
    if (!now || diffDesigns(ctx.imported, now).length === 0) {
      hooks.toast('Nothing has changed yet. Edit the rocket first, then save your fix.');
      return;
    }
    noteOpen = true;
    render();
  }

  async function saveFix(note: string): Promise<void> {
    const c = ctx;
    const corrected = hooks.getDesign();
    if (!c || !corrected) return;
    const record = makeCorrection({
      fileSha256: c.sha,
      filename: c.filename,
      parsedModel: c.parsedModel,
      imported: c.imported,
      corrected,
      note: note.trim(),
    });
    saveLocalCorrection(record);
    c.saved = record;
    c.showing = 'fixed';
    noteOpen = false;
    render();
    const cloud = await cloudReady;
    hooks.toast(
      cloud.store.enabled
        ? 'Fix saved to your account. This file will open your way from now on.'
        : 'Fix saved in this browser. Sign in to keep it on every device.',
    );
    await cloud.store.saveCorrection(record, cloud.mayCollect());
  }

  async function forgetFix(): Promise<void> {
    const c = ctx;
    if (!c) return;
    deleteLocalCorrection(c.sha);
    c.saved = null;
    c.showing = 'original';
    hooks.loadDesign(c.imported);
    render();
    hooks.toast('Your fix was removed. The file opens as we import it.');
    const cloud = await cloudReady;
    await cloud.store.deleteCorrection(c.sha);
  }

  return {
    async afterImport({ bytes, filename, format, parsedModel, imported }) {
      let sha: string;
      try {
        sha = await sha256Hex(bytes);
      } catch {
        return; // No Web Crypto (very old browser): the import still works, just without fixes.
      }
      const mine: Context = { sha, filename, parsedModel, imported, saved: null, showing: 'original' };
      ctx = mine;
      dismissed = false;
      noteOpen = false;

      const cloud = await cloudReady;
      const saved = pickCorrection(loadLocalCorrection(sha), await cloud.store.getCorrection(sha));
      if (ctx !== mine) return; // Another file was opened while we were looking.
      if (saved) {
        mine.saved = saved;
        mine.showing = 'fixed';
        saveLocalCorrection(saved); // So it also works offline on this device.
        hooks.loadDesign(saved.correctedDesign);
        hooks.toast(`Opened "${filename}" with your saved fix.`);
      }
      render();

      // Only with consent: keep the original file, the raw material for training.
      if (cloud.mayCollect()) {
        void cloud.store.uploadRocketFile({ sha256: sha, filename, format, bytes });
      }
    },
    sourceSha: () => ctx?.sha,
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      sync();
    },
    clear() {
      ctx = null;
      noteOpen = false;
      render();
    },
  };
}
