// LocalStorage persistence and JSON import/export for builder designs.
// Pure TypeScript — accepts any StorageLike (defaults to window.localStorage).

import type { Design } from './design';
import { sanitizeDesignObject } from '../io/limits';

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
export const MAX_SAVED_DESIGNS = 40;

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

/** Sanitize one stored entry; null when it is not a usable saved design. */
function sanitizeSaved(item: unknown): SavedDesign | null {
  if (!item || typeof item !== 'object') return null;
  const e = item as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.design || typeof e.design !== 'object') return null;
  try {
    const design = sanitizeDesignObject(e.design as Record<string, unknown>, 'Untitled Rocket', []);
    return {
      id: e.id.slice(0, 64),
      name: typeof e.name === 'string' && e.name ? e.name.slice(0, 120) : design.name,
      savedAt: typeof e.savedAt === 'number' && Number.isFinite(e.savedAt) ? e.savedAt : 0,
      ...(typeof e.thumbnail === 'string' && e.thumbnail.startsWith('data:image/') ? { thumbnail: e.thumbnail } : {}),
      design,
    };
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
    return parsed
      .slice(0, 100)
      .map(sanitizeSaved)
      .filter((item): item is SavedDesign => item !== null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

const STORAGE_FULL_MESSAGE = 'Storage is full. Delete a saved rocket and try again.';

/**
 * Save a design. Throws `Error('Storage is full. Delete a saved rocket and try again.')` when the
 * browser refuses the write, after first retrying without the thumbnails of the older entries.
 */
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
    if (existing.length >= MAX_SAVED_DESIGNS) {
      throw new Error(`You have ${MAX_SAVED_DESIGNS} saved rockets. Delete one in Save / Open to save another.`);
    }
    const next = [entry, ...existing].slice(0, MAX_SAVED_DESIGNS);
    try {
      s.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota: drop the thumbnails of every older entry (the biggest part of each) and retry once.
      try {
        const slim = next.map((e, i) => {
          if (i === 0) return e;
          const { thumbnail: _drop, ...rest } = e;
          return rest as SavedDesign;
        });
        s.setItem(STORAGE_KEY, JSON.stringify(slim));
      } catch {
        throw new Error(STORAGE_FULL_MESSAGE);
      }
    }
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
  const candidate = (obj.format === 'sfb-design' && obj.design && typeof obj.design === 'object'
    ? obj.design
    : obj) as Record<string, unknown>;
  if (!Array.isArray(candidate.stack)) {
    throw new Error('JSON file is missing a valid rocket stack.');
  }
  // Same sanitizer as file imports: unknown parts dropped, numbers finite and clamped, sizes capped.
  return sanitizeDesignObject(candidate, 'Imported Rocket', []);
}
