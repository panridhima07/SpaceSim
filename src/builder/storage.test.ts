import { describe, it, expect } from 'vitest';
import { addExternalPart, createEmptyDesign } from './design';
import { findPreset } from './parts';
import {
  deleteSavedDesign,
  exportDesignJson,
  importDesignJson,
  listSavedDesigns,
  saveDesign,
  STORAGE_KEY,
  type StorageLike,
} from './storage';
import type { BodyTube, NoseCone } from '../types';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

describe('builder/storage', () => {
  it('saves, lists, updates and deletes designs in storage', () => {
    const store = memoryStorage();
    let d = createEmptyDesign('Alpha 1');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    d = addExternalPart(d, findPreset('tube-bt50-240')!.create() as BodyTube).design;

    saveDesign(d, 'data:image/png;base64,AAA', store);
    const list1 = listSavedDesigns(store);
    expect(list1).toHaveLength(1);
    expect(list1[0].name).toBe('Alpha 1');
    expect(list1[0].thumbnail).toBe('data:image/png;base64,AAA');

    // Re-saving same ID updates in place
    saveDesign({ ...d, name: 'Alpha 1 Rev 2' }, undefined, store);
    const list2 = listSavedDesigns(store);
    expect(list2).toHaveLength(1);
    expect(list2[0].name).toBe('Alpha 1 Rev 2');

    deleteSavedDesign(d.id, store);
    expect(listSavedDesigns(store)).toHaveLength(0);
  });

  it('exports and imports JSON cleanly and rejects invalid JSON', () => {
    let d = createEmptyDesign('JSON Rocket');
    d = addExternalPart(d, findPreset('nose-ogive-bt50')!.create() as NoseCone).design;
    const text = exportDesignJson(d);
    const imported = importDesignJson(text);
    expect(imported.name).toBe('JSON Rocket');
    expect(imported.stack).toHaveLength(1);
    expect(imported.stack[0].part.kind).toBe('nosecone');

    expect(() => importDesignJson('{bad json')).toThrow();
    expect(() => importDesignJson('{"hello": 1}')).toThrow();
  });
});

describe('builder/storage hostile data', () => {
  const body = { kind: 'bodytube', outerRadius: 0.025, length: 0.3, thickness: 0.001, density: 680 };

  it('importDesignJson sanitizes instead of copying the stack verbatim', () => {
    const d = importDesignJson(JSON.stringify({
      stack: [
        { id: 'x', part: { ...body, outerRadius: 1e9 }, children: [{ id: 'y', part: { kind: 'finset', rootChord: 0.1, span: 0.05, count: 1e9 } }, { part: null }] },
        { id: 'z' },
        { id: 'w', part: { kind: 'nope' } },
      ],
    }));
    expect(d.stack).toHaveLength(1);
    expect(d.stack[0].part.kind === 'bodytube' && d.stack[0].part.outerRadius).toBe(10);
    expect(d.stack[0].children).toHaveLength(1);
    expect(() => importDesignJson(JSON.stringify({ stack: [{ id: 'q' }] }))).toThrow();
  });

  it('listSavedDesigns drops or repairs corrupt entries', () => {
    const store = memoryStorage();
    store.setItem(STORAGE_KEY, JSON.stringify([
      { id: 'bad', savedAt: 1, design: { stack: [{ part: 'x' }] } },
      { id: 'good', savedAt: 2, design: { id: 'good', name: 'G', stack: [{ id: 'a', part: body, children: [] }], nextId: 5 } },
    ]));
    const list = listSavedDesigns(store);
    expect(list.map((e) => e.id)).toEqual(['good']);
  });

  it('saveDesign throws a friendly error when storage is full, after retrying without old thumbnails', () => {
    const calls: string[] = [];
    const store: StorageLike = {
      getItem: () => null,
      setItem: (_k, v) => { calls.push(v); throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    const d = createEmptyDesign('Full');
    expect(() => saveDesign(d, undefined, store)).toThrow('Storage is full. Delete a saved rocket and try again.');
    expect(calls).toHaveLength(2);
  });

  it('saveDesign refuses a 41st design but still re-saves one of the existing 40', () => {
    const store = memoryStorage();
    const designs = Array.from({ length: 40 }, (_, i) => {
      const base = { ...createEmptyDesign(`R${i}`), id: `d${i}` };
      return addExternalPart(base, findPreset('tube-bt50-240')!.create() as BodyTube).design;
    });
    for (const d of designs) saveDesign(d, undefined, store);
    expect(listSavedDesigns(store)).toHaveLength(40);

    const extra = { ...createEmptyDesign('Extra'), id: 'd_extra' };
    expect(() => saveDesign(extra, undefined, store)).toThrow(
      'You have 40 saved rockets. Delete one in Save / Open to save another.',
    );
    expect(listSavedDesigns(store)).toHaveLength(40);

    expect(() => saveDesign({ ...designs[5], name: 'R5 edited' }, undefined, store)).not.toThrow();
    const after = listSavedDesigns(store);
    expect(after).toHaveLength(40);
    expect(after.find((e) => e.id === 'd5')?.name).toBe('R5 edited');
  });
});
