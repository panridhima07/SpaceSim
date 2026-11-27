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

/** Who gave the consent answer stored in this browser: a user id, or 'guest'. */
const CONSENT_OWNER_KEY = 'sfb.consent.owner.v1';

function readConsentOwner(): string | null {
  try {
    return window.localStorage.getItem(CONSENT_OWNER_KEY);
  } catch {
    return null;
  }
}

function writeConsentOwner(owner: string): void {
  try {
    window.localStorage.setItem(CONSENT_OWNER_KEY, owner);
  } catch {
    // Storage refused: the answer then lasts for this page only.
  }
}

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

  // The answer saved in this browser belongs to whoever gave it: another account (or a guest)
  // on the same browser must be asked themselves, not inherit it.
  const owner = userId ?? 'guest';
  const savedOwner = readConsentOwner();
  let consent = readLocalConsent();
  // Answers saved before owners were recorded are kept for guests only.
  if (consent && (savedOwner === null ? signedIn : savedOwner !== owner)) consent = null;
  const keepLocal = (c: ConsentState): void => {
    writeLocalConsent(c);
    writeConsentOwner(owner);
  };
  if (signedIn) {
    // The account's answer follows the person across devices; the newer one wins.
    // undefined = the read failed: then nothing is overwritten either way.
    const remote = await store.getConsent().catch(() => undefined);
    if (remote && (!consent || remote.decidedAt > consent.decidedAt)) {
      consent = remote;
      keepLocal(remote);
    } else if (consent && remote !== undefined && (remote === null || consent.decidedAt > remote.decidedAt)) {
      // This device holds a newer answer than the account (an earlier save failed, for
      // example offline): send it again, withdrawal included.
      void pushConsent(consent);
    }
  }

  async function pushConsent(decision: ConsentState): Promise<void> {
    await store.setConsent(decision).catch(() => false);
    // "It stops from then on": nothing already stored stays marked for training. Cheap and
    // idempotent, so it is repeated whenever the answer is "no".
    if (!decision.research && supabase && userId) {
      await supabase
        .from('import_corrections')
        .update({ share_for_training: false })
        .eq('user_id', userId)
        .eq('share_for_training', true)
        .then(
          () => {},
          () => {},
        );
    }
  }

  let asking: Promise<ConsentState> | null = null;
  const askConsent = (): Promise<ConsentState> => {
    if (asking) return asking;
    asking = showConsentDialog({ current: consent, signedIn })
      .then(async (decision) => {
        consent = decision;
        keepLocal(decision);
        if (signedIn) await pushConsent(decision);
        return decision;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  };

  window.addEventListener(OPEN_CONSENT_EVENT, () => void askConsent());
  // Guests have nothing to opt into (research needs an account) and their data stays in the
  // browser, so they are not interrupted; the account menu still opens the popup.
  if (signedIn && needsConsent(consent)) {
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
