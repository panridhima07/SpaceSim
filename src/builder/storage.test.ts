import { describe, it, expect } from 'vitest';
import { addExternalPart, createEmptyDesign } from './design';
import { findPreset } from './parts';
import {
  deleteSavedDesign,
  exportDesignJson,
  importDesignJson,
  listSavedDesigns,
  saveDesign,
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
