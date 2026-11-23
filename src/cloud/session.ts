// Ties the cloud pieces to the signed-in person: one store for the page, the consent
// decision (asked once, changeable from the account menu), and the access token the
// server-side simulation needs.

import { currentSession, supabase } from '../auth/client';
import { needsConsent, readLocalConsent, showConsentDialog, writeLocalConsent } from './consent';
import './consent.css';
import { createCloudStore, type CloudStore } from './store';
import type { ConsentState } from './types';

/** Fired on window to reopen the consent popup (the account menu does this). */
export const OPEN_CONSENT_EVENT = 'astra-open-consent';

export interface Cloud {
  readonly store: CloudStore;
  /** False for guests and when sign-in is not set up. */
  readonly signedIn: boolean;
  /** The current decision; null until the person has answered. */
  consent(): ConsentState | null;
  /** True only when a signed-in person agreed to share data for training. */
  mayCollect(): boolean;
  /** A fresh access token, or undefined for guests. */
  accessToken(): Promise<string | undefined>;
  /** Show the popup now and store the answer. */
  askConsent(): Promise<ConsentState>;
}

const NO_STORE = createCloudStore(null, null);

/**
 * Work out who is signed in and what they agreed to. Never throws: with no network, no
 * sign-in or no tables the result is a guest-like cloud that stores nothing remotely.
 * The popup is shown shortly after, without holding up the app.
 */
export async function initCloud(): Promise<Cloud> {
  const session = supabase ? await currentSession().catch(() => null) : null;
  const userId = session?.user?.id ?? null;
  const signedIn = userId !== null;
  const store = signedIn ? createCloudStore(supabase, userId) : NO_STORE;

  let consent = readLocalConsent();
  if (signedIn) {
    // The account's answer follows the person across devices; the newer one wins.
    const remote = await store.getConsent().catch(() => null);
    if (remote && (!consent || remote.decidedAt > consent.decidedAt)) {
      consent = remote;
      writeLocalConsent(remote);
    }
  }

  let asking: Promise<ConsentState> | null = null;
  const askConsent = (): Promise<ConsentState> => {
    if (asking) return asking;
    asking = showConsentDialog({ current: consent, signedIn })
      .then(async (decision) => {
        const withdrew = consent?.research === true && !decision.research;
        consent = decision;
        writeLocalConsent(decision);
        if (signedIn) {
          await store.setConsent(decision).catch(() => {});
          // "It stops from then on": nothing already stored stays marked for training.
          if (withdrew && supabase) {
            await supabase.from('import_corrections').update({ share_for_training: false }).eq('user_id', userId).then(
              () => {},
              () => {},
            );
          }
        }
        return decision;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  };

  window.addEventListener(OPEN_CONSENT_EVENT, () => void askConsent());
  if (needsConsent(consent)) {
    // After the first paint, so the popup opens over a drawn app rather than a blank page.
    window.setTimeout(() => void askConsent(), 600);
  }

  return {
    store,
    signedIn,
    consent: () => consent,
    mayCollect: () => signedIn && consent?.research === true,
    accessToken: async () => {
      if (!signedIn) return undefined;
      const s = await currentSession().catch(() => null);
      return s?.access_token;
    },
    askConsent,
  };
}
