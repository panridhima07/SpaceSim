import { describe, expect, it } from 'vitest';
import { fillDaily, parseReleases, parseStats, sumOf, windowDays } from './shape';
import type { DailyRow } from './types';

const validStats = () => ({
  days: 3,
  from: '2026-11-30',
  daily: [
    { day: '2026-11-30', platform: 'web', opens: 4, devices: 2, signed_in_devices: 1, flights: 1, missions: 0, imports: 2 },
    { day: '2026-12-01', platform: 'android', opens: '7', devices: 3, signed_in_devices: 0, flights: 2, missions: 1, imports: 0 },
  ],
  devices: [
    { platform: 'web', devices: 5, signed_in_devices: 2 },
    { platform: 'android', devices: 3, signed_in_devices: 0 },
  ],
  versions: [{ platform: 'android', version: '1.1.0', devices: 3 }],
  totals: {
    accounts: 9,
    designs: 12,
    uploads: 4,
    sim_runs: [{ kind: 'flight', ran_on: 'browser', count: 30 }],
  },
});

describe('parseStats', () => {
  it('parses a valid payload and coerces numbers', () => {
    const stats = parseStats(validStats());
    expect(stats.days).toBe(3);
    expect(stats.from).toBe('2026-11-30');
    expect(stats.daily).toHaveLength(2);
    expect(stats.daily[1].opens).toBe(7);
    expect(stats.devices[0]).toEqual({ platform: 'web', devices: 5, signed_in_devices: 2 });
    expect(stats.versions[0].version).toBe('1.1.0');
    expect(stats.totals.accounts).toBe(9);
    expect(stats.totals.sim_runs[0].count).toBe(30);
  });

  it('throws on null and non-object input', () => {
    expect(() => parseStats(null)).toThrow('Unexpected data from the server');
    expect(() => parseStats('nope')).toThrow('Unexpected data from the server');
    expect(() => parseStats([])).toThrow('Unexpected data from the server');
  });

  it('throws when daily is missing or not an array of objects', () => {
    const missing = validStats() as Partial<ReturnType<typeof validStats>>;
    delete missing.daily;
    expect(() => parseStats(missing)).toThrow('Unexpected data from the server');

    expect(() => parseStats({ ...validStats(), daily: 'rows' })).toThrow('Unexpected data from the server');
    expect(() => parseStats({ ...validStats(), daily: [42] })).toThrow('Unexpected data from the server');
  });

  it('throws when totals or one of its counts is missing', () => {
    const noTotals = validStats() as Partial<ReturnType<typeof validStats>>;
    delete noTotals.totals;
    expect(() => parseStats(noTotals)).toThrow('Unexpected data from the server');

    expect(() =>
      parseStats({ ...validStats(), totals: { designs: 1, uploads: 1 } }),
    ).toThrow('Unexpected data from the server');
  });

  it('drops rows for unknown platforms', () => {
    const raw = validStats();
    raw.daily.push({ day: '2026-12-02', platform: 'ios', opens: 99, devices: 1, signed_in_devices: 0, flights: 0, missions: 0, imports: 0 } as never);
    const stats = parseStats(raw);
    expect(stats.daily.some((r) => r.platform === ('ios' as string))).toBe(false);
    expect(stats.daily).toHaveLength(2);
  });

  it('treats missing device, version and sim run arrays as empty', () => {
    const raw = validStats() as Partial<ReturnType<typeof validStats>>;
    delete raw.devices;
    delete raw.versions;
    const stats = parseStats({ ...raw, totals: { accounts: 0, designs: 0, uploads: 0 } });
    expect(stats.devices).toEqual([]);
    expect(stats.versions).toEqual([]);
    expect(stats.totals.sim_runs).toEqual([]);
  });
});

describe('parseReleases', () => {
  it('sums only .apk assets, case-insensitively', () => {
    const out = parseReleases([
      {
        tag_name: 'v1.1.0',
        published_at: '2026-11-20T10:00:00Z',
        draft: false,
        assets: [
          { name: 'astra-1.1.0.APK', download_count: 10 },
          { name: 'notes.txt', download_count: 500 },
          { name: 'astra.apk', download_count: 5 },
        ],
      },
    ]);
    expect(out).toEqual([{ tag: 'v1.1.0', published: '2026-11-20T10:00:00Z', downloads: 15 }]);
  });

  it('skips drafts and keeps input order', () => {
    const out = parseReleases([
      { tag_name: 'v2', published_at: '', draft: true, assets: [{ name: 'a.apk', download_count: 1 }] },
      { tag_name: 'v1', published_at: '2026-01-01T00:00:00Z', draft: false, assets: [] },
      { tag_name: 'v0', published_at: '2025-01-01T00:00:00Z', assets: [{ name: 'b.apk', download_count: 3 }] },
    ]);
    expect(out.map((r) => r.tag)).toEqual(['v1', 'v0']);
    expect(out[1].downloads).toBe(3);
  });

  it('returns [] for junk input', () => {
    expect(parseReleases(null)).toEqual([]);
    expect(parseReleases({ tag_name: 'v1' })).toEqual([]);
    expect(parseReleases('x')).toEqual([]);
  });
});

describe('windowDays', () => {
  it('returns the requested number of consecutive days', () => {
    expect(windowDays('2026-11-01', 30)).toHaveLength(30);
    expect(windowDays('2026-11-01', 7)).toHaveLength(7);
    expect(windowDays('2026-11-01', 0)).toEqual([]);
  });

  it('crosses a month boundary in UTC', () => {
    expect(windowDays('2026-11-29', 4)).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });

  it('crosses a leap-year boundary', () => {
    expect(windowDays('2028-02-28', 3)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});

describe('fillDaily', () => {
  it('zero-fills days with no server row and keeps the given rows', () => {
    const stats = parseStats(validStats());
    const web = fillDaily(stats, 'web');
    expect(web.map((r) => r.day)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
    expect(web[0]).toMatchObject({ opens: 4, devices: 2, imports: 2 });
    expect(web[1]).toEqual({
      day: '2026-12-01',
      platform: 'web',
      opens: 0,
      devices: 0,
      signed_in_devices: 0,
      flights: 0,
      missions: 0,
      imports: 0,
    });
  });

  it('only includes rows for the asked platform', () => {
    const stats = parseStats(validStats());
    const android = fillDaily(stats, 'android');
    expect(android.every((r) => r.platform === 'android')).toBe(true);
    expect(android[1].opens).toBe(7);
    expect(android[0].opens).toBe(0);
  });
});

describe('sumOf', () => {
  it('sums a numeric field over rows', () => {
    const rows: DailyRow[] = [
      { day: '2026-11-01', platform: 'web', opens: 2, devices: 1, signed_in_devices: 0, flights: 1, missions: 0, imports: 3 },
      { day: '2026-11-02', platform: 'web', opens: 5, devices: 1, signed_in_devices: 0, flights: 2, missions: 4, imports: 0 },
    ];
    expect(sumOf(rows, 'opens')).toBe(7);
    expect(sumOf(rows, 'flights')).toBe(3);
    expect(sumOf(rows, 'missions')).toBe(4);
    expect(sumOf(rows, 'imports')).toBe(3);
    expect(sumOf([], 'opens')).toBe(0);
  });
});
