// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { formatViewDistance } from './missionUi';

describe('formatViewDistance', () => {
  it('shows metres below 1 km', () => {
    expect(formatViewDistance(45)).toBe('45 m');
    expect(formatViewDistance(0)).toBe('0 m');
  });

  it('shows one-decimal kilometres from 1 km to 100 km', () => {
    expect(formatViewDistance(12_300)).toBe('12.3 km');
    expect(formatViewDistance(1_000)).toBe('1.0 km');
  });

  it('shows whole kilometres with a space thousands separator from 100 km up to 1e10 m', () => {
    expect(formatViewDistance(384_400_000)).toBe('384 400 km');
  });

  it('shows astronomical units for solar-system distances', () => {
    expect(formatViewDistance(149_597_870_700)).toBe('1.00 AU');
  });

  it('returns an empty string for NaN, infinity and negative distances', () => {
    expect(formatViewDistance(NaN)).toBe('');
    expect(formatViewDistance(-1)).toBe('');
    expect(formatViewDistance(Infinity)).toBe('');
  });
});
