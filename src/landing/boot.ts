// Page entry: sign in first, then load the Moon landing view.
import { requireAuth } from '../auth/gate';
import { logUsage } from '../cloud/usage';
import { liveUpdateBoot, liveUpdateReady } from '../app/liveUpdate';
import { initNativeShell } from '../app/native';
import { showFatal } from '../app/fatal';

// Android app: system Back button (returns to the builder).
void initNativeShell();

void (async () => {
  // Android app: a downloaded web update is applied when a page boots (src/app/liveUpdate.ts).
  await liveUpdateBoot();
  logUsage('open');
  window.addEventListener('astra-first-screen', liveUpdateReady, { once: true });
  await requireAuth();
  try {
    await import('./main');
  } catch (err) {
    showFatal(err);
    return;
  }
  liveUpdateReady();
})();
