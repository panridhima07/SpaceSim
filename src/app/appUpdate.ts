// Android app only: tells people when a newer APK has been published.
//
// The feed is the project's latest GitHub release. Publishing an update is: bump "version" in
// package.json, build the signed APK (npm run android:release) and attach it to a release
// tagged v<version>. Installed apps see it on their next start and offer the download.
//
// Builds for Google Play are made with VITE_APP_UPDATE_FEED=off (npm run android:bundle):
// Play updates the app itself and does not allow apps to update from anywhere else.
import { Capacitor } from '@capacitor/core';
import './appUpdate.css';

declare const __APP_VERSION__: string | undefined;

/** Version of this build, from package.json. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export const DEFAULT_UPDATE_FEED = 'https://api.github.com/repos/panridhima07/SpaceSim/releases/latest';
/** Downloads are only ever opened from here, whatever the feed says. */
const DOWNLOAD_PREFIX = 'https://github.com/';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const KEY_LAST_CHECK = 'astra-update-last-check';
const KEY_DISMISSED = 'astra-update-dismissed';

export interface AppUpdate {
  version: string;
  /** Direct APK download when the release has one, else the release page. */
  url: string;
}

/** "v1.2.3", "1.2" or "1.2.3-beta" as [major, minor, patch]; null when it is not a version. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

export function isNewer(remote: unknown, local: unknown): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i];
  }
  return false;
}

/** Reads a GitHub "latest release" response. Null when it holds no newer, safely linked version. */
export function updateFromRelease(release: unknown, localVersion: string): AppUpdate | null {
  if (typeof release !== 'object' || release === null) return null;
  const r = release as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  const parsed = parseVersion(r.tag_name);
  if (!parsed || !isNewer(r.tag_name, localVersion)) return null;

  const safe = (u: unknown): u is string => typeof u === 'string' && u.startsWith(DOWNLOAD_PREFIX);
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown }[]) : [];
  const apk = assets.find((a) => typeof a?.name === 'string' && /\.apk$/i.test(a.name) && safe(a.browser_download_url));
  const url = apk ? (apk.browser_download_url as string) : safe(r.html_url) ? r.html_url : null;
  return url ? { version: parsed.join('.'), url } : null;
}

function feedUrl(): string | null {
  const v = (import.meta.env?.VITE_APP_UPDATE_FEED ?? '').trim();
  if (v.toLowerCase() === 'off') return null;
  return v || DEFAULT_UPDATE_FEED;
}

function showBanner(update: AppUpdate): void {
  const bar = document.createElement('div');
  bar.className = 'astra-update';
  bar.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'astra-update-text';
  text.textContent = `Version ${update.version} is available`;

  const get = document.createElement('button');
  get.type = 'button';
  get.className = 'astra-update-get';
  get.textContent = 'Update';
  get.addEventListener('click', () => {
    void import('@capacitor/browser').then(({ Browser }) => Browser.open({ url: update.url }));
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'astra-update-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => {
    try {
      localStorage.setItem(KEY_DISMISSED, update.version);
    } catch {
      /* private mode: it will simply show again next time */
    }
    bar.remove();
  });

  bar.append(text, get, close);
  document.body.append(bar);
}

/**
 * Checks the release feed (at most every 6 hours) and shows a banner when a newer version is
 * out. Does nothing on the website. Never throws: offline or a bad response is ignored.
 */
export async function checkForAppUpdate(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform()) return;
    const feed = feedUrl();
    if (!feed) return;
    const now = Date.now();
    const last = Number(localStorage.getItem(KEY_LAST_CHECK));
    if (Number.isFinite(last) && last > 0 && now - last < CHECK_INTERVAL_MS) return;

    // Native HTTP: the page's Content-Security-Policy and CORS do not apply to it.
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.get({
      url: feed,
      headers: { accept: 'application/vnd.github+json' },
      connectTimeout: 8000,
      readTimeout: 8000,
    });
    if (res.status !== 200) return;
    localStorage.setItem(KEY_LAST_CHECK, String(now));
    const data: unknown = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const update = updateFromRelease(data, APP_VERSION);
    if (!update || localStorage.getItem(KEY_DISMISSED) === update.version) return;
    showBanner(update);
  } catch {
    /* offline, rate limited or malformed: try again on a later start */
  }
}
