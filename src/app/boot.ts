// Page entry: sign in first, then load the builder. The app module starts work as soon as
// it is imported, so it is imported only after there is a session.
import { requireAuth } from '../auth/gate';
import { initNativeShell } from './native';

// Android app: system Back button. Started before the sign-in gate so Back works there too.
void initNativeShell();

// Set when this visit came through the landing page; main.ts then opens build mode.
void requireAuth('astra-enter-build')
  .then(() => import('./main'))
  // Android app: offer a newer APK once the builder is up. No-op on the website.
  .then(() => import('./appUpdate'))
  .then((m) => m.checkForAppUpdate());
