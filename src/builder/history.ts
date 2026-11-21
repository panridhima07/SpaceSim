// Immutable undo/redo history stack for Build Mode.
// Pure TypeScript — no DOM, no three.js.

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  readonly maxDepth: number;
}

export function createHistory<T>(initial: T, maxDepth = 100): History<T> {
  return {
    past: [],
    present: initial,
    future: [],
    maxDepth: Math.max(1, maxDepth),
  };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

/** Push a new state onto the undo stack, clearing any redo branch. */
export function pushHistory<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  if (past.length > h.maxDepth) {
    past.splice(0, past.length - h.maxDepth);
  }
  return {
    past,
    present: next,
    future: [],
    maxDepth: h.maxDepth,
  };
}

/**
 * Replace the current present state without adding an undo entry.
 * Useful for continuous slider drags after an initial snapshot has been pushed.
 */
export function replacePresent<T>(h: History<T>, next: T): History<T> {
  return {
    past: h.past,
    present: next,
    future: h.future,
    maxDepth: h.maxDepth,
  };
}

export function undoHistory<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present: prev,
    future: [h.present, ...h.future],
    maxDepth: h.maxDepth,
  };
}

export function redoHistory<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const next = h.future[0];
  return {
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(1),
    maxDepth: h.maxDepth,
  };
}
