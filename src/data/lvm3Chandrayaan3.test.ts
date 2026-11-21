import { describe, it, expect } from 'vitest';
import { LVM3_CHANDRAYAAN3_EVENTS } from './lvm3Chandrayaan3';

describe('LVM3_CHANDRAYAAN3_EVENTS', () => {
  it('contains monotonically increasing event times with non-empty sources', () => {
    expect(LVM3_CHANDRAYAAN3_EVENTS.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < LVM3_CHANDRAYAAN3_EVENTS.length; i++) {
      const ev = LVM3_CHANDRAYAAN3_EVENTS[i];
      expect(ev.timeS).toBeGreaterThan(0);
      expect(ev.source.length).toBeGreaterThan(0);
      if (i > 0) {
        expect(ev.timeS).toBeGreaterThan(LVM3_CHANDRAYAAN3_EVENTS[i - 1].timeS);
      }
    }
  });
});
