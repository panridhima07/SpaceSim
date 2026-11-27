// Why the dashboard's data request was refused, in words for the person looking at it.
// The decision itself is made by public.admin_stats() in the database.

export type StatsFailure = 'not-admin' | 'not-set-up' | 'signed-out' | 'other';

/** Why admin_stats() failed, from the PostgREST / Postgres error. */
export function classifyStatsError(error: { code?: string; message?: string } | null | undefined): StatsFailure {
  const code = error?.code ?? '';
  const message = (error?.message ?? '').toLowerCase();
  // 42501: raised by the function for accounts that are not listed (also "permission denied").
  if (code === '42501' || message.includes('not an admin')) return 'not-admin';
  // PGRST202: no such function in the API schema; 42883: undefined function; 42P01: undefined table.
  if (code === 'PGRST202' || code === '42883' || code === '42P01') return 'not-set-up';
  if (code === 'PGRST301' || code === 'PGRST303' || message.includes('jwt')) return 'signed-out';
  return 'other';
}

export const FAILURE_TEXT: Record<StatsFailure, string> = {
  'not-admin': 'This account is not an admin.',
  // The migration hint is for the developer; signed-in admins see a neutral line in production.
  'not-set-up': import.meta.env.DEV
    ? 'The database is not set up for statistics yet. Run migration 0003_usage_and_admin.sql in the Supabase SQL editor.'
    : 'Statistics are not available yet.',
  'signed-out': 'Your session has expired. Sign in again.',
  other: 'Could not load the statistics. Check your connection and try again.',
};
