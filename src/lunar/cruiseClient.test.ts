import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CruiseRecord } from './cruise';

const flyCruise = vi.hoisted(() => vi.fn());
vi.mock('./cruise', () => ({ flyCruise }));

// runCruise caches its promise at module level, so each test gets a fresh copy of the module.
async function freshClient(): Promise<typeof import('./cruiseClient')> {
  vi.resetModules();
  return import('./cruiseClient');
}

const fakeRecord = { epochJD: 2460000.5, n: 0 } as unknown as CruiseRecord;

describe('runCruise (no-Worker fallback)', () => {
  beforeEach(() => {
    flyCruise.mockReset();
    expect(typeof Worker).toBe('undefined');
  });

  it('flies the cruise in this thread and forwards progress text', async () => {
    flyCruise.mockImplementation((opts: { onProgress?: (t: string) => void }) => {
      opts.onProgress?.('half way');
      return fakeRecord;
    });
    const { runCruise } = await freshClient();
    const progress = vi.fn();
    await expect(runCruise(progress)).resolves.toBe(fakeRecord);
    expect(flyCruise).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith('half way');
  });

  it('caches a successful flight: a second call returns the same promise and flies nothing', async () => {
    flyCruise.mockReturnValue(fakeRecord);
    const { runCruise } = await freshClient();
    const p1 = runCruise();
    const p2 = runCruise();
    expect(p2).toBe(p1);
    await p1;
    const p3 = runCruise();
    expect(p3).toBe(p1);
    await expect(p3).resolves.toBe(fakeRecord);
    expect(flyCruise).toHaveBeenCalledTimes(1);
  });

  it('rejects with an Error when the flight throws, then clears the cache so a retry flies again', async () => {
    flyCruise.mockImplementationOnce(() => {
      throw new Error('The launcher did not reach the transfer orbit');
    });
    flyCruise.mockReturnValueOnce(fakeRecord);
    const { runCruise } = await freshClient();

    const first = runCruise();
    await expect(first).rejects.toThrow(/transfer orbit/);
    // Let the cache-clearing catch handler run.
    await Promise.resolve();

    const second = runCruise();
    expect(second).not.toBe(first);
    await expect(second).resolves.toBe(fakeRecord);
    expect(flyCruise).toHaveBeenCalledTimes(2);
  });

  it('wraps a non-Error throw in an Error', async () => {
    flyCruise.mockImplementation(() => {
      throw 'boom';
    });
    const { runCruise } = await freshClient();
    const err = await runCruise().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
  });
});
