// LocalStorage persistence and JSON import/export for builder designs.
// Pure TypeScript — accepts any StorageLike (defaults to window.localStorage).

import type { Design } from './design';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SavedDesign {
  id: string;
  name: string;
  savedAt: number;
  thumbnail?: string;
  design: Design;
}

export const STORAGE_KEY = 'sfb.builder.designs.v1';

function resolveStorage(store?: StorageLike): StorageLike | null {
  if (store) return store;
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function listSavedDesigns(store?: StorageLike): SavedDesign[] {
  const s = resolveStorage(store);
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as SavedDesign[])
      .filter((item) => item && typeof item.id === 'string' && item.design && Array.isArray(item.design.stack))
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  } catch {
    return [];
  }
}

export function saveDesign(
  design: Design,
  thumbnail?: string,
  store?: StorageLike,
): SavedDesign {
  const entry: SavedDesign = {
    id: design.id,
    name: design.name || 'Untitled Rocket',
    savedAt: Date.now(),
    ...(thumbnail ? { thumbnail } : {}),
    design,
  };
  const s = resolveStorage(store);
  if (s) {
    const existing = listSavedDesigns(s).filter((e) => e.id !== entry.id);
    const next = [entry, ...existing].slice(0, 40);
    s.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return entry;
}

export function deleteSavedDesign(id: string, store?: StorageLike): void {
  const s = resolveStorage(store);
  if (!s) return;
  const next = listSavedDesigns(s).filter((e) => e.id !== id);
  s.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function exportDesignJson(design: Design): string {
  return JSON.stringify(
    {
      format: 'sfb-design',
      version: 1,
      design,
    },
    null,
    2,
  );
}

export function importDesignJson(text: string): Design {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON file does not contain a rocket design.');
  }
  const obj = parsed as Record<string, unknown>;
  const candidate = (obj.format === 'sfb-design' && obj.design ? obj.design : obj) as Partial<Design>;
  if (!candidate || !Array.isArray(candidate.stack)) {
    throw new Error('JSON file is missing a valid rocket stack.');
  }
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `d_${Date.now().toString(36)}`,
    name: typeof candidate.name === 'string' && candidate.name ? candidate.name : 'Imported Rocket',
    stack: candidate.stack,
    nextId: typeof candidate.nextId === 'number' && candidate.nextId > 0 ? candidate.nextId : candidate.stack.length + 10,
  };
}
