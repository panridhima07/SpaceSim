// Page entry: sign in first, then load the builder. The app module starts work as soon as
// it is imported, so it is imported only after there is a session.
import { requireAuth } from '../auth/gate';

// Set when this visit came through the landing page; main.ts then opens build mode.
void requireAuth('astra-enter-build').then(() => import('./main'));
