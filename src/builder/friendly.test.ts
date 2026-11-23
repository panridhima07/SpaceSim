import { describe, it, expect } from 'vitest';
import { PART_PRESETS } from './parts';
import { friendlyPart, matchesSearch, sizeBadge } from './friendly';

describe('friendlyPart', () => {
  it('gives every preset a plain name with no hobby tube codes', () => {
    for (const p of PART_PRESETS) {
      const f = friendlyPart(p);
      expect(f.name.length).toBeGreaterThan(2);
      expect(f.name).not.toMatch(/BT-\d|Ogive|Ellipsoid|Mount ·|undefined/);
      expect(f.detail).not.toMatch(/BT-\d|Cd |undefined/);
    }
  });

  it('names engines by power and keeps the code', () => {
    const c6 = friendlyPart(PART_PRESETS.find((p) => p.presetId === 'mount-18mm-c6')!);
    expect(c6.name).toBe('Small engine C6');
  });

  it('searches plain words, original codes and sizes', () => {
    const nose = friendlyPart(PART_PRESETS.find((p) => p.presetId === 'nose-ogive-bt50')!);
    expect(matchesSearch(nose, 'pointed')).toBe(true);
    expect(matchesSearch(nose, 'bt-50 nose')).toBe(true);
    expect(matchesSearch(nose, 'parachute')).toBe(false);
    expect(sizeBadge(24.8)).toBe('S');
  });
});
