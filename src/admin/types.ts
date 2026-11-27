// Shapes shared by the admin page: what public.admin_stats() returns (see
// supabase/migrations/0003_usage_and_admin.sql) and what the dashboard is given.

export type Platform = 'web' | 'android';
export type StatsWindow = 7 | 30 | 90;

/** One UTC day of usage on one platform. Days with no usage have no row. */
export interface DailyRow {
  /** YYYY-MM-DD (UTC). */
  day: string;
  platform: Platform;
  opens: number;
  /** Distinct devices seen that day. */
  devices: number;
  /** Of those, devices that were signed in at some point that day. */
  signed_in_devices: number;
  flights: number;
  missions: number;
  imports: number;
}

/** Distinct devices over the whole window, per platform. */
export interface DeviceTotals {
  platform: Platform;
  devices: number;
  signed_in_devices: number;
}

/** Devices that used a version in the window. Android: the installed APK's version. Web: the site's. */
export interface VersionRow {
  platform: Platform;
  version: string;
  devices: number;
}

export interface SimRunRow {
  /** 'flight' | 'stress' | '' */
  kind: string;
  /** 'server' | 'browser' | '' */
  ran_on: string;
  count: number;
}

export interface AdminStats {
  days: number;
  /** First day of the window, YYYY-MM-DD (UTC). The last day is today (UTC). */
  from: string;
  daily: DailyRow[];
  devices: DeviceTotals[];
  versions: VersionRow[];
  /** All-time counts. */
  totals: { accounts: number; designs: number; uploads: number; sim_runs: SimRunRow[] };
}

/** APK downloads of one GitHub release (sum over its .apk assets). */
export interface ReleaseDownloads {
  tag: string;
  /** ISO date-time, or '' when unknown. */
  published: string;
  downloads: number;
}

export interface DashboardOptions {
  /** Signed-in admin's email, shown in the header. */
  email: string;
  /** Rejects with an Error whose message is ready to show. */
  loadStats(days: StatsWindow): Promise<AdminStats>;
  /** Rejects when GitHub cannot be reached. */
  loadReleases(): Promise<ReleaseDownloads[]>;
  onSignOut(): void;
}
