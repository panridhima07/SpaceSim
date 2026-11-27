// Anonymous usage counts (table and rules: supabase/migrations/0003_usage_and_admin.sql; read
// on /admin.html).
//
// One row per device, day, platform and event; no IP, email, user id or rocket data. The device
// is a random id kept in localStorage. Nothing is sent when the browser asks not to be tracked,
// on a website served from localhost, or in debug builds of the Android app.
import { Capacitor } from '@capacitor/core';
import { supabase } from '../auth/client';
import { nativeInfo } from '../app/apkUpdater';
import { APP_VERSION } from '../app/buildInfo';

export type UsageEvent = 'open' | 'flight' | 'mission' | 'import';

const KEY_INSTALL = 'astra-install-id';
const KEY_OPEN_SENT = 'astra-usage-open';

export interface UsageEnv {
  /** navigator.doNotTrack */
  doNotTrack: string | null | undefined;
  /** navigator.globalPrivacyControl */
  globalPrivacyControl: boolean | undefined;
  hostname: string;
  /** Inside the Android app (which is served from https://localhost). */
  native: boolean;
  /** Android app only: a debug build. */
  nativeDebug: boolean;
}

/** Whether this device may be counted at all. */
export function usageAllowed(env: UsageEnv): boolean {
  if (env.doNotTrack === '1' || env.doNotTrack === 'yes' || env.globalPrivacyControl === true) return false;
  if (env.native) return !env.nativeDebug;
  // The host name only rules out the website in development: the app has the same host.
  return !['localhost', '127.0.0.1', '[::1]', ''].includes(env.hostname);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

/** The device's random id, created on first use. Null when storage is unavailable (nothing is sent then). */
export function installId(store?: KeyValue): string | null {
  try {
    const s = store ?? window.localStorage;
    const have = s.getItem(KEY_INSTALL);
    if (have && UUID.test(have)) return have;
    const fresh = crypto.randomUUID();
    s.setItem(KEY_INSTALL, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * 'open' is counted once per browser session (or app launch), not once per page: true the
 * first time only. Always true for the other events.
 */
export function shouldSend(event: UsageEvent, session?: KeyValue): boolean {
  if (event !== 'open') return true;
  try {
    const s = session ?? window.sessionStorage;
    if (s.getItem(KEY_OPEN_SENT)) return false;
    s.setItem(KEY_OPEN_SENT, '1');
    return true;
  } catch {
    return true;
  }
}

async function send(event: UsageEvent): Promise<void> {
  if (!supabase) return;
  const native = Capacitor.isNativePlatform();
  const info = native ? await nativeInfo() : null;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const allowed = usageAllowed({
    doNotTrack: nav.doNotTrack,
    globalPrivacyControl: nav.globalPrivacyControl,
    hostname: window.location.hostname,
    native,
    nativeDebug: info?.debug === true,
  });
  if (!allowed || !shouldSend(event)) return;
  const id = installId();
  if (!id) return;
  await supabase.rpc('log_usage', {
    p_install_id: id,
    p_platform: native ? 'android' : 'web',
    p_event: event,
    p_app_version: APP_VERSION,
    p_native_version: info?.versionName ?? '',
  });
}

/** Counts one event. Fire and forget: never throws, never blocks the caller. */
export function logUsage(event: UsageEvent): void {
  void send(event).catch(() => {});
}
