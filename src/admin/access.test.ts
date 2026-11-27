import { describe, expect, it } from 'vitest';
import { classifyStatsError, FAILURE_TEXT } from './access';

describe('classifyStatsError', () => {
  it('treats 42501 and "not an admin" as not-admin', () => {
    expect(classifyStatsError({ code: '42501' })).toBe('not-admin');
    expect(classifyStatsError({ message: 'Not an admin' })).toBe('not-admin');
  });
  it('treats missing function or table errors as not-set-up', () => {
    expect(classifyStatsError({ code: 'PGRST202' })).toBe('not-set-up');
    expect(classifyStatsError({ code: '42883' })).toBe('not-set-up');
    expect(classifyStatsError({ code: '42P01' })).toBe('not-set-up');
  });
  it('treats auth and JWT errors as signed-out', () => {
    expect(classifyStatsError({ code: 'PGRST301' })).toBe('signed-out');
    expect(classifyStatsError({ message: 'JWT expired' })).toBe('signed-out');
  });
  it('falls back to other for anything else', () => {
    expect(classifyStatsError(null)).toBe('other');
    expect(classifyStatsError(undefined)).toBe('other');
    expect(classifyStatsError({})).toBe('other');
    expect(classifyStatsError({ code: '500', message: 'boom' })).toBe('other');
  });
});

describe('FAILURE_TEXT', () => {
  it('has non-empty text for every failure', () => {
    for (const key of ['not-admin', 'not-set-up', 'signed-out', 'other'] as const) {
      expect(FAILURE_TEXT[key].length).toBeGreaterThan(0);
    }
  });
  it('names the migration only in development; production gets a neutral line', () => {
    if (import.meta.env.DEV) {
      expect(FAILURE_TEXT['not-set-up']).toContain('0003');
    } else {
      expect(FAILURE_TEXT['not-set-up']).toBe('Statistics are not available yet.');
      expect(FAILURE_TEXT['not-set-up']).not.toContain('0003');
    }
  });
});
