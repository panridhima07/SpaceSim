// Page entry: sign in first, then load the Moon landing view.
import { requireAuth } from '../auth/gate';

void requireAuth().then(() => import('./main'));
