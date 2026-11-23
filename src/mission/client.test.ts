import { describe, expect, it } from 'vitest';
import { isAbortError, runMission } from './client';

describe('runMission', () => {
  it('rejects an unknown mission id', async () => {
    await expect(runMission('nope')).rejects.toThrow(/Unknown mission/);
  });

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await runMission('lvm3-m4', {}, controller.signal).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect((err as Error).name).toBe('AbortError');
  });

  it('flies lvm3-m4 in the in-thread fallback', async () => {
    const record = await runMission('lvm3-m4', { sampleInterval: 2 });
    expect(record.reachedTarget).toBe(true);
    expect(record.samples.length).toBeGreaterThan(0);
  }, 60_000);

  it('forwards failureCase and destructive options through the in-thread fallback', async () => {
    const record = await runMission('lvm3-m4', {
      sampleInterval: 2,
      failureCase: 'gimbal-lock',
      destructive: true,
    });
    expect(record.failureCase).toBe('gimbal-lock');
    expect(record.outcome?.outcome).toBe('breakup');
    expect(record.outcome?.summary.length).toBeGreaterThan(0);
  }, 60_000);
});
