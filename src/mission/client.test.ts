import { describe, expect, it } from 'vitest';
import { runMission } from './client';

describe('runMission', () => {
  it('rejects an unknown mission id', async () => {
    await expect(runMission('nope')).rejects.toThrow(/Unknown mission/);
  });

  it('flies lvm3-m4 in the in-thread fallback', async () => {
    const record = await runMission('lvm3-m4', { sampleInterval: 2 });
    expect(record.reachedTarget).toBe(true);
    expect(record.samples.length).toBeGreaterThan(0);
  }, 60_000);
});
