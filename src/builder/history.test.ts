import { describe, it, expect } from 'vitest';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  replacePresent,
  undoHistory,
} from './history';

describe('builder/history', () => {
  it('supports push, undo, redo, and clears redo on new push', () => {
    let h = createHistory('a');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);

    h = pushHistory(h, 'b');
    h = pushHistory(h, 'c');
    expect(h.present).toBe('c');
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);

    h = undoHistory(h);
    expect(h.present).toBe('b');
    expect(canRedo(h)).toBe(true);

    h = undoHistory(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);

    h = redoHistory(h);
    expect(h.present).toBe('b');

    h = pushHistory(h, 'd');
    expect(h.present).toBe('d');
    expect(canRedo(h)).toBe(false);
  });

  it('caps history at maxDepth', () => {
    let h = createHistory(0, 3);
    for (let i = 1; i <= 5; i++) h = pushHistory(h, i);
    expect(h.past).toEqual([2, 3, 4]);
    expect(h.present).toBe(5);
  });

  it('replacePresent updates without creating an extra undo step', () => {
    let h = createHistory(1);
    h = pushHistory(h, 2);
    h = replacePresent(h, 2.5);
    expect(h.present).toBe(2.5);
    expect(h.past).toEqual([1]);
  });
});
