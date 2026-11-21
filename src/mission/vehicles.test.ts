import { describe, expect, it } from 'vitest';
import { getMission, MISSIONS } from './vehicles';

describe('MISSIONS', () => {
  it('contains the LVM3-M4 mission', () => {
    const mission = getMission('lvm3-m4');
    expect(mission).toBeDefined();
    expect(mission?.name).toBe('LVM3-M4 / Chandrayaan-3');
  });

  it('has six reference events in increasing time order', () => {
    const mission = getMission('lvm3-m4');
    expect(mission?.reference).toHaveLength(6);
    const times = mission!.reference.map((r) => r.t);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it('returns undefined for an unknown id', () => {
    expect(getMission('nope')).toBeUndefined();
  });

  it('has unique ids', () => {
    const ids = MISSIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
