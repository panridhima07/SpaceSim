// Things that differ between the website and the Android app (the same build in a Capacitor
// WebView, served from https://localhost).
import { Capacitor } from '@capacitor/core';

/** The public website. The app uses it for links that must work outside the app. */
export const PUBLIC_SITE_URL = (import.meta.env?.VITE_PUBLIC_SITE_URL || 'https://astra-spaceflight.vercel.app').replace(
  /\/+$/,
  '',
);

/**
 * Base URL for a share link. On the website it is the current page. Inside the app the page
 * lives at https://localhost, which nobody else can open, so links point at the website.
 */
export function shareBaseUrl(native = Capacitor.isNativePlatform(), href = window.location.href): string {
  return native ? `${PUBLIC_SITE_URL}/` : href.split('#')[0];
}

let shellStarted = false;

/**
 * Android only: make the system Back button work. Without a listener the App plugin swallows
 * Back on the first page, so the app could not be left with it. Back now returns to the
 * previous page (Moon landing to builder), and on the first page sends the app to the background.
 */
export async function initNativeShell(): Promise<void> {
  if (shellStarted || !Capacitor.isNativePlatform()) return;
  shellStarted = true;
  const { App } = await import('@capacitor/app');
  await App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back();
    else void App.minimizeApp();
  });
}
