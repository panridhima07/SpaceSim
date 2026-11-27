// Android app only: tells people when a newer APK has been published, and installs it.
//
// The feed is the project's latest GitHub release. Publishing an update is: bump "version" in
// package.json, build the signed APK (npm run android:release) and attach it to a release
// tagged v<version>. Installed apps see it on their next start and show an "Update" bar. The
// bar downloads the APK inside the app and hands it to Android's installer (ApkUpdaterPlugin);
// if that fails for any reason it opens the download in the browser instead.
//
// The release is compared with the installed APK's version, not with the version of the web
// content, which a web update (src/app/liveUpdate.ts) changes without touching the APK.
//
// Builds for Google Play (npm run android:bundle) never show the bar: Play updates the app
// itself and does not allow apps to update from anywhere else. The APK says so itself
// (nativeInfo().play), so this holds whatever web content it is running.
import { Capacitor } from '@capacitor/core';
import { ApkUpdater, nativeInfo } from './apkUpdater';
import { APP_VERSION } from './buildInfo';
import './appUpdate.css';

export { APP_VERSION };

export const DEFAULT_UPDATE_FEED = 'https://api.github.com/repos/panridhima07/SpaceSim/releases/latest';
/** Downloads are only ever taken from the project's own releases, whatever the feed says. */
export const DEFAULT_DOWNLOAD_PREFIX = 'https://github.com/panridhima07/SpaceSim/releases/';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const KEY_LAST_CHECK = 'astra-update-last-check';
const KEY_DISMISSED = 'astra-update-dismissed';
const KEY_FOUND = 'astra-update-found';

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
  // 1.3.0 is newer than an installed 1.3.0-beta.
  return isPreRelease(local) && !isPreRelease(remote);
}

function isPreRelease(v: unknown): boolean {
  return typeof v === 'string' && /^v?[0-9.]+-/.test(v.trim());
}

/** Reads a GitHub "latest release" response. Null when it holds no newer, safely linked version. */
export function updateFromRelease(release: unknown, localVersion: string, prefix: string = DEFAULT_DOWNLOAD_PREFIX): AppUpdate | null {
  if (typeof release !== 'object' || release === null) return null;
  const r = release as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  const parsed = parseVersion(r.tag_name);
  if (!parsed || !isNewer(r.tag_name, localVersion)) return null;

  const safe = (u: unknown): u is string => typeof u === 'string' && u.startsWith(prefix);
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown }[]) : [];
  const apk = assets.find((a) => typeof a?.name === 'string' && /\.apk$/i.test(a.name) && safe(a.browser_download_url));
  const url = apk ? (apk.browser_download_url as string) : safe(r.html_url) ? r.html_url : null;
  return url ? { version: parsed.join('.'), url } : null;
}

/**
 * The update found by an earlier check, if it is still worth offering: well formed, from the
 * allowed place and newer than what is installed now. Lets the bar come back after a restart
 * inside the check interval (for example after allowing installs in Settings).
 */
export function rememberedUpdate(raw: string | null, localVersion: string, prefix: string = DEFAULT_DOWNLOAD_PREFIX): AppUpdate | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as { version?: unknown; url?: unknown };
    if (typeof u.version !== 'string' || typeof u.url !== 'string') return null;
    if (!u.url.startsWith(prefix) || !isNewer(u.version, localVersion)) return null;
    return { version: u.version, url: u.url };
  } catch {
    return null;
  }
}

/** True when the link is an APK file (installable in the app) rather than a release page. */
export function isApkUrl(url: string): boolean {
  try {
    return /\.apk$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function feedUrl(): string | null {
  const v = (import.meta.env?.VITE_APP_UPDATE_FEED ?? '').trim();
  if (v.toLowerCase() === 'off') return null;
  return v || DEFAULT_UPDATE_FEED;
}

function downloadPrefix(): string {
  return (import.meta.env?.VITE_APP_UPDATE_DOWNLOAD_PREFIX ?? '').trim() || DEFAULT_DOWNLOAD_PREFIX;
}

async function openInBrowser(url: string): Promise<void> {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url });
}

function showBanner(update: AppUpdate, canInstall: boolean): void {
  const bar = document.createElement('div');
  bar.className = 'astra-update';
  bar.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'astra-update-text';
  const idle = `Version ${update.version} is available`;
  text.textContent = idle;

  const get = document.createElement('button');
  get.type = 'button';
  get.className = 'astra-update-get';
  get.textContent = 'Update';

  let busy = false;
  get.addEventListener('click', () => {
    if (busy) return;
    if (!canInstall || !isApkUrl(update.url)) {
      void openInBrowser(update.url).catch(() => {});
      return;
    }
    busy = true;
    get.disabled = true;
    text.textContent = 'Downloading…';
    void (async () => {
      const progress = await ApkUpdater.addListener('apkProgress', ({ received, total }) => {
        text.textContent = total > 0 ? `Downloading… ${Math.min(100, Math.round((received / total) * 100))}%` : 'Downloading…';
      }).catch(() => null);
      try {
        const res = await ApkUpdater.downloadAndInstall({ url: update.url, version: update.version });
        text.textContent = res.status === 'permission' ? 'Allow installs for this app, then tap Update again' : idle;
      } catch {
        // Anything went wrong in the app: fall back to the browser download.
        text.textContent = idle;
        await openInBrowser(update.url).catch(() => {});
      } finally {
        await progress?.remove().catch(() => {});
        busy = false;
        get.disabled = false;
      }
    })();
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
 * out. Between checks the last result is shown again. Does nothing on the website or in a
 * Google Play build. Never throws: offline or a bad response is ignored.
 */
export async function checkForAppUpdate(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform()) return;
    const info = await nativeInfo();
    if (info?.play) return;
    const feed = feedUrl();
    if (!feed) return;
    // The installed APK's version. An APK from before the plugin existed has no native info;
    // its web content is the APK's own, so the web version is right there.
    const local = info?.versionName || APP_VERSION;
    const prefix = downloadPrefix();
    const offer = (update: AppUpdate | null): void => {
      if (!update || localStorage.getItem(KEY_DISMISSED) === update.version) return;
      showBanner(update, info !== null);
    };

    const now = Date.now();
    const last = Number(localStorage.getItem(KEY_LAST_CHECK));
    if (Number.isFinite(last) && last > 0 && now - last < CHECK_INTERVAL_MS) {
      offer(rememberedUpdate(localStorage.getItem(KEY_FOUND), local, prefix));
      return;
    }

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
    const update = updateFromRelease(data, local, prefix);
    if (update) localStorage.setItem(KEY_FOUND, JSON.stringify(update));
    else localStorage.removeItem(KEY_FOUND);
    offer(update);
  } catch {
    /* offline, rate limited or malformed: try again on a later start */
  }
}
