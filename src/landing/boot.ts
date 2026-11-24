// Page entry: sign in first, then load the Moon landing view.
import { requireAuth } from '../auth/gate';
import { initNativeShell } from '../app/native';

// Android app: system Back button (returns to the builder).
void initNativeShell();

void requireAuth().then(() => import('./main'));
