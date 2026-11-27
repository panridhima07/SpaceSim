// Pure helpers for the admin dashboard: validate what admin_stats() and GitHub return,
// and shape daily rows for the charts. All dates are UTC (YYYY-MM-DD).
import type { AdminStats, DailyRow, Platform, ReleaseDownloads, SimRunRow, VersionRow, DeviceTotals } from './types';

const PLATFORMS: readonly Platform[] = ['web', 'android'];
const DAY_MS = 86_400_000;
const BAD_SHAPE = 'Unexpected data from the server';

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlatform(v: unknown): v is Platform {
  return typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);
}

function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(BAD_SHAPE);
  return n;
}

/** A missing array is treated as empty; anything present must be an array. */
function optionalArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(BAD_SHAPE);
  return v;
}

export function parseStats(raw: unknown): AdminStats {
  if (!isObject(raw)) throw new Error(BAD_SHAPE);
  const { from, daily, totals } = raw;
  if (typeof from !== 'string' || !Array.isArray(daily) || !isObject(totals)) {
    throw new Error(BAD_SHAPE);
  }

  const dailyRows: DailyRow[] = [];
  for (const row of daily) {
    if (!isObject(row) || typeof row.day !== 'string') throw new Error(BAD_SHAPE);
    if (!isPlatform(row.platform)) continue;
    dailyRows.push({
      day: row.day,
      platform: row.platform,
      opens: num(row.opens),
      devices: num(row.devices),
      signed_in_devices: num(row.signed_in_devices),
      flights: num(row.flights),
      missions: num(row.missions),
      imports: num(row.imports),
    });
  }

  const devices: DeviceTotals[] = [];
  for (const row of optionalArray(raw.devices)) {
    if (!isObject(row)) throw new Error(BAD_SHAPE);
    if (!isPlatform(row.platform)) continue;
    devices.push({
      platform: row.platform,
      devices: num(row.devices),
      signed_in_devices: num(row.signed_in_devices),
    });
  }

  const versions: VersionRow[] = [];
  for (const row of optionalArray(raw.versions)) {
    if (!isObject(row)) throw new Error(BAD_SHAPE);
    if (!isPlatform(row.platform)) continue;
    versions.push({
      platform: row.platform,
      version: typeof row.version === 'string' ? row.version : '',
      devices: num(row.devices),
    });
  }

  const simRuns: SimRunRow[] = [];
  for (const row of optionalArray(totals.sim_runs)) {
    if (!isObject(row)) throw new Error(BAD_SHAPE);
    simRuns.push({
      kind: typeof row.kind === 'string' ? row.kind : '',
      ran_on: typeof row.ran_on === 'string' ? row.ran_on : '',
      count: num(row.count),
    });
  }

  return {
    days: num(raw.days),
    from,
    daily: dailyRows,
    devices,
    versions,
    totals: {
      accounts: num(totals.accounts),
      designs: num(totals.designs),
      uploads: num(totals.uploads),
      sim_runs: simRuns,
    },
  };
}

/** Sums the .apk assets of each non-draft GitHub release. Input order is kept (newest first). */
export function parseReleases(raw: unknown): ReleaseDownloads[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseDownloads[] = [];
  for (const release of raw) {
    if (!isObject(release) || release.draft === true) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    let downloads = 0;
    for (const asset of assets) {
      if (!isObject(asset) || typeof asset.name !== 'string') continue;
      if (!asset.name.toLowerCase().endsWith('.apk')) continue;
      const count = Number(asset.download_count);
      if (Number.isFinite(count)) downloads += count;
    }
    out.push({
      tag: typeof release.tag_name === 'string' ? release.tag_name : '',
      published: typeof release.published_at === 'string' ? release.published_at : '',
      downloads,
    });
  }
  return out;
}

/** `days` consecutive UTC days starting at `from`, oldest first. Empty when `from` is not YYYY-MM-DD. */
export function windowDays(from: string, days: number): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const count = Math.floor(days);
  if (!m || !(count > 0)) return [];
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(start + i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

/** One row per day of the window for one platform; days the server sent no row for are zero. */
export function fillDaily(stats: AdminStats, platform: Platform): DailyRow[] {
  const byDay = new Map<string, DailyRow>();
  for (const row of stats.daily) {
    if (row.platform === platform) byDay.set(row.day, row);
  }
  return windowDays(stats.from, stats.days).map(
    (day) =>
      byDay.get(day) ?? {
        day,
        platform,
        opens: 0,
        devices: 0,
        signed_in_devices: 0,
        flights: 0,
        missions: 0,
        imports: 0,
      },
  );
}

export function sumOf(rows: DailyRow[], key: 'opens' | 'flights' | 'missions' | 'imports'): number {
  return rows.reduce((total, row) => total + row[key], 0);
}
