// Android app only: keeps the web content current without a new APK.
//
// Every website deploy also publishes the same build as a zip ("bundle") with a small manifest
// (scripts/make-app-bundle.mjs). The app reads the manifest on each launch, downloads a newer
// bundle in the background and switches to it the next time a page boots. The switch never
// happens while the app is merely in the background, so returning from Google sign-in or a Save
// dialog never finds a reloaded page.
//
// Safety net, in two layers:
//  1. A new bundle must call notifyAppReady() (liveUpdateReady, once the first screen is up)
//     within the plugin's appReadyTimeout, or the plugin puts the previous content back.
//  2. If the builder then fails to load, liveUpdateBroken() returns to the content inside the APK.
// Either way the build is remembered as failed on this device and never downloaded again.
//
// The plugin (@capgo/capacitor-updater) is used in manual mode only: autoUpdate is off and its
// stats, update and channel URLs are empty (capacitor.config.json), so it contacts no server
// other than the download URL given here.
import { Capacitor } from '@capacitor/core';
import { nativeInfo } from './apkUpdater';
import { BUILD_ID } from './buildInfo';
import { PUBLIC_SITE_URL } from './native';

export const DEFAULT_BUNDLE_FEED = `${PUBLIC_SITE_URL}/app-update/manifest.json`;

const KEY_PENDING = 'astra-live-pending';
const KEY_APPLYING = 'astra-live-applying';
const KEY_FAILED = 'astra-live-failed';
const MAX_FAILED = 20;

export interface BundleManifest {
  /** UTC build time, YYYYMMDDHHmmss. */
  build: string;
  version: string;
  /** Lowest Android version code that can run this web content. */
  minNativeCode: number;
  /** Lowercase hex SHA-256 of the zip. */
  sha256: string;
  /** Plain file name of the zip, beside the manifest. */
  file: string;
}

/** A downloaded bundle waiting for the next page boot. */
export interface PendingBundle {
  /** The plugin's id for the downloaded bundle. */
  id: string;
  build: string;
}

const BUILD_RE = /^\d{14}$/;

export function isBuildId(v: unknown): v is string {
  return typeof v === 'string' && BUILD_RE.test(v);
}

/** Reads a manifest. Null unless every field is present and well formed. */
export function parseManifest(raw: unknown): BundleManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (!isBuildId(m.build)) return null;
  if (typeof m.version !== 'string' || m.version.length > 40) return null;
  if (typeof m.minNativeCode !== 'number' || !Number.isInteger(m.minNativeCode) || m.minNativeCode < 0) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
  // A plain file name: no folders, no URL, nothing that could point somewhere else.
  if (typeof m.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.zip$/.test(m.file)) return null;
  return { build: m.build, version: m.version, minNativeCode: m.minNativeCode, sha256: m.sha256, file: m.file };
}

/** The zip's URL: the manifest's own URL with the last path segment replaced. HTTPS only, unless allowHttp (debug builds, for a local test feed). */
export function bundleUrl(feed: string, file: string, allowHttp = false): string | null {
  try {
    const base = new URL(feed);
    if (base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) return null;
    const u = new URL(file, base);
    if (u.origin !== base.origin) return null;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export interface UpdateState {
  /** Build id of the running web content ('' when unknown: never update then). */
  build: string;
  /** Installed APK's version code. */
  nativeCode: number;
  /** Builds that failed on this device. */
  failed: readonly string[];
  /** Build already downloaded and waiting, if any. */
  pendingBuild: string | null;
}

/** Whether to download the bundle the manifest describes. */
export function shouldDownload(manifest: BundleManifest, state: UpdateState): boolean {
  if (!isBuildId(state.build)) return false;
  // Build ids are fixed-width digit strings, so text order is time order.
  if (manifest.build <= state.build) return false;
  if (manifest.minNativeCode > state.nativeCode) return false;
  if (state.failed.includes(manifest.build)) return false;
  if (state.pendingBuild === manifest.build) return false;
  return true;
}

export type BootAction =
  /** Nothing to do. */
  | { kind: 'none' }
  /** The build we tried to switch to is not the one running: it was rolled back. */
  | { kind: 'mark-failed'; build: string }
  /** Switch to the downloaded bundle now. */
  | { kind: 'apply'; pending: PendingBundle }
  /** The waiting bundle is stale (not newer, or known bad): forget it. */
  | { kind: 'drop-pending' };

/**
 * What to do when a page boots.
 * `applying` is the build a previous boot switched to; while it is set and a different build is
 * running, that switch did not hold.
 */
export function bootAction(build: string, pending: PendingBundle | null, applying: string | null, failed: readonly string[]): BootAction {
  if (applying && applying !== build) return { kind: 'mark-failed', build: applying };
  if (!pending) return { kind: 'none' };
  if (!isBuildId(build) || pending.build <= build || failed.includes(pending.build)) return { kind: 'drop-pending' };
  return { kind: 'apply', pending };
}

// ---------- device storage ----------

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: updates simply do not persist */
  }
}

export function parsePending(raw: string | null): PendingBundle | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 64 && isBuildId(p.build) ? { id: p.id, build: p.build } : null;
  } catch {
    return null;
  }
}

export function parseFailed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isBuildId).slice(-MAX_FAILED) : [];
  } catch {
    return [];
  }
}

function rememberFailed(build: string): void {
  if (!isBuildId(build)) return;
  const list = parseFailed(read(KEY_FAILED)).filter((b) => b !== build);
  list.push(build);
  write(KEY_FAILED, JSON.stringify(list.slice(-MAX_FAILED)));
}

// ---------- native glue ----------

function feedUrl(): { url: string | null; explicit: boolean } {
  const v = (import.meta.env?.VITE_APP_BUNDLE_FEED ?? '').trim();
  if (v.toLowerCase() === 'off') return { url: null, explicit: true };
  return v ? { url: v, explicit: true } : { url: DEFAULT_BUNDLE_FEED, explicit: false };
}

interface Enabled {
  feed: string;
  nativeCode: number;
  debug: boolean;
}

let enabledOnce: Promise<Enabled | null> | null = null;

/** Null when live updates do not apply: the website, an APK without the plugins, feed "off", or a debug build without an explicit feed. */
function enabled(): Promise<Enabled | null> {
  enabledOnce ??= (async () => {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('CapacitorUpdater')) return null;
    const feed = feedUrl();
    if (!feed.url) return null;
    const info = await nativeInfo();
    if (!info) return null;
    // A debug rebuild keeps its version code, so the plugin would keep serving an older
    // downloaded bundle over the freshly built content. Debug builds update only on request.
    if (info.debug && !feed.explicit) return null;
    return { feed: feed.url, nativeCode: info.versionCode, debug: info.debug };
  })().catch(() => null);
  return enabledOnce;
}

/** Frees a downloaded bundle nothing will boot into. Never the running one; never throws. */
async function discard(id: string): Promise<void> {
  try {
    const { plugin } = await updater();
    if ((await plugin.current()).bundle.id === id) return;
    await plugin.delete({ id });
  } catch {
    /* it only costs storage: leave it */
  }
}

// Returned inside an object: a Capacitor plugin proxy answers every property, including
// "then", so returning it directly from an async function would be treated as a promise.
async function updater() {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  return { plugin: CapacitorUpdater };
}

/**
 * First thing on every page boot. Switches to a downloaded bundle (the page then reloads and
 * this promise never settles), or records that the last switch was rolled back.
 * Resolves quickly in every other case; never rejects.
 */
export async function liveUpdateBoot(): Promise<void> {
  try {
    // Nothing recorded: skip the native round trips entirely (the usual launch).
    const pendingRaw = read(KEY_PENDING);
    const applying = read(KEY_APPLYING);
    if (!pendingRaw && !applying) return;
    if (!(await enabled())) return;

    const action = bootAction(BUILD_ID, parsePending(pendingRaw), applying, parseFailed(read(KEY_FAILED)));
    if (action.kind === 'mark-failed') {
      rememberFailed(action.build);
      write(KEY_APPLYING, null);
      write(KEY_PENDING, null);
      return;
    }
    if (action.kind === 'drop-pending') {
      const dropped = parsePending(pendingRaw);
      write(KEY_PENDING, null);
      if (dropped) void discard(dropped.id);
      return;
    }
    if (action.kind !== 'apply') return;

    const { plugin } = await updater();
    write(KEY_APPLYING, action.pending.build);
    write(KEY_PENDING, null);
    try {
      // Reloads the page into the new bundle. On success this page is gone before it resolves.
      await plugin.set({ id: action.pending.id });
      await new Promise<never>(() => {});
    } catch {
      // The bundle no longer exists (for example a new APK cleared it): not a failed build.
      write(KEY_APPLYING, null);
    }
  } catch {
    /* never block startup */
  }
}

let readySent = false;

/** Call once the first screen (sign-in or builder) is on screen: the running bundle is good. */
export function liveUpdateReady(): void {
  if (readySent) return;
  readySent = true;
  void (async () => {
    try {
      if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('CapacitorUpdater')) return;
      const { plugin } = await updater();
      await plugin.notifyAppReady();
      if (read(KEY_APPLYING) === BUILD_ID) write(KEY_APPLYING, null);
    } catch {
      /* the plugin's own timeout handles a bundle that cannot confirm */
    }
  })();
}

/**
 * The running content cannot start (the builder failed to load, or it has no sign-in
 * configuration). If it is a downloaded bundle: remember it as failed and go back to the
 * content inside the APK (the page reloads). Does nothing for built-in content or on the website.
 */
export async function liveUpdateBroken(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('CapacitorUpdater')) return;
    const { plugin } = await updater();
    const current = await plugin.current();
    if (current.bundle.id === 'builtin') return;
    rememberFailed(BUILD_ID);
    write(KEY_APPLYING, null);
    write(KEY_PENDING, null);
    await plugin.reset({ toLastSuccessful: false });
  } catch {
    /* nothing more can be done from here */
  }
}

/**
 * Looks for a newer bundle and downloads it for the next boot. Runs in the background on every
 * launch, before the sign-in gate, so a fixed deploy can always reach a phone. Never throws.
 */
export async function checkForWebUpdate(): Promise<void> {
  try {
    const on = await enabled();
    if (!on) return;
    // Native HTTP: the page's Content-Security-Policy does not list the website.
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.get({
      url: on.feed,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      connectTimeout: 8000,
      readTimeout: 8000,
    });
    if (res.status !== 200) return;
    const manifest = parseManifest(typeof res.data === 'string' ? JSON.parse(res.data) : res.data);
    if (!manifest) return;
    const pending = parsePending(read(KEY_PENDING));
    const state: UpdateState = {
      build: BUILD_ID,
      nativeCode: on.nativeCode,
      failed: parseFailed(read(KEY_FAILED)),
      pendingBuild: pending?.build ?? null,
    };
    if (!shouldDownload(manifest, state)) return;
    const url = bundleUrl(on.feed, manifest.file, on.debug);
    if (!url) return;
    const { plugin } = await updater();
    // The plugin verifies the checksum and rejects on a mismatch.
    const bundle = await plugin.download({ url, version: manifest.build, checksum: manifest.sha256 });
    write(KEY_PENDING, JSON.stringify({ id: bundle.id, build: manifest.build } satisfies PendingBundle));
    // Only once the newer one is safely down: the older download will never be used.
    if (pending && pending.id !== bundle.id) await discard(pending.id);
  } catch {
    /* offline, bad manifest, failed download: try again on a later launch */
  }
}
