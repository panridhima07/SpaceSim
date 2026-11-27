// Page entry: sign in first, then load the builder. The app module starts work as soon as
// it is imported, so it is imported only after there is a session.
import { requireAuth } from '../auth/gate';
import { supabase } from '../auth/client';
import { logUsage } from '../cloud/usage';
import { checkForWebUpdate, liveUpdateBoot, liveUpdateBroken, liveUpdateReady } from './liveUpdate';
import { initNativeShell } from './native';
import { showFatal } from './fatal';

// Android app: system Back button. Started before the sign-in gate so Back works there too.
void initNativeShell();

void (async () => {
  // Android app: switch to a downloaded web update before anything is on screen (the page
  // reloads once in that case). Returns at once when there is none, and on the website.
  await liveUpdateBoot();
  // Android app: look for a newer web bundle in the background. Before the sign-in gate, so a
  // fixed deploy can always reach a phone, whatever state the running content is in.
  void checkForWebUpdate();
  // Web content without sign-in settings can never get past the gate: if it came from a web
  // update, go back to the content inside the APK.
  if (!supabase) await liveUpdateBroken();

  logUsage('open');
  // The sign-in screen counts as "this content works" for a web update (src/auth/gate.ts).
  window.addEventListener('astra-first-screen', liveUpdateReady, { once: true });

  // Set when this visit came through the landing page; main.ts then opens build mode.
  await requireAuth('astra-enter-build');
  try {
    await import('./main');
  } catch (err) {
    // The builder cannot load: a web update that does this is reverted.
    await liveUpdateBroken();
    showFatal(err);
    return;
  }
  liveUpdateReady();
  // Android app: offer a newer APK once the builder is up. No-op on the website.
  const { checkForAppUpdate } = await import('./appUpdate');
  await checkForAppUpdate();
})();
