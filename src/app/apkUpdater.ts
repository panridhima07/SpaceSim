// JS side of the Android-only ApkUpdater plugin
// (android/app/src/main/java/com/astra/spaceflightbuilder/ApkUpdaterPlugin.java).
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeInfo {
  /** Debuggable build (run-android.cmd, npm run android:apk). */
  debug: boolean;
  /** Built for Google Play (npm run android:bundle): Play updates the app, so no APK update bar. */
  play: boolean;
  versionCode: number;
  versionName: string;
}

export interface ApkInstallResult {
  /**
   * 'installer': Android's installer was opened.
   * 'permission': the "install unknown apps" setting was opened instead; try again afterwards.
   */
  status: 'installer' | 'permission';
}

export interface ApkUpdaterPlugin {
  info(): Promise<NativeInfo>;
  /** Downloads the APK (reusing a finished download of the same version), checks it and opens the installer. */
  downloadAndInstall(options: { url: string; version: string }): Promise<ApkInstallResult>;
  addListener(event: 'apkProgress', cb: (p: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
}

export const ApkUpdater = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');

let cached: Promise<NativeInfo | null> | null = null;

/** Facts about the installed APK. Null on the website, or in an APK from before this plugin existed. */
export function nativeInfo(): Promise<NativeInfo | null> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(null);
  cached ??= ApkUpdater.info().then(
    (i) => ({
      debug: i.debug === true,
      play: i.play === true,
      versionCode: Number(i.versionCode) || 0,
      versionName: typeof i.versionName === 'string' ? i.versionName : '',
    }),
    () => null,
  );
  return cached;
}
