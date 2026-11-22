// The Supabase client and the sign-in calls. Works on the website and inside the Android app.
//
// Website: Google sends the browser back to the page with ?code=..., which the client
// exchanges for a session on load.
// Android: Google opens in the system browser and returns through the deep link
// com.astra.spaceflightbuilder://auth-callback?code=..., handled in listenForNativeCallback.

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const NATIVE_REDIRECT = 'com.astra.spaceflightbuilder://auth-callback';

export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
      })
    : null;

function client(): SupabaseClient {
  if (!supabase) throw new Error('Sign-in is not set up: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing.');
  return supabase;
}

/** What an OAuth or email-link return URL carries: a code to exchange, or an error to show. */
export function parseAuthCallback(href: string): { code?: string; error?: string } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return {};
  }
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const get = (name: string) => u.searchParams.get(name) ?? hash.get(name) ?? undefined;
  const error = get('error_description') ?? get('error');
  if (error) return { error: error.replace(/\+/g, ' ') };
  const code = get('code');
  return code ? { code } : {};
}

export async function currentSession(): Promise<Session | null> {
  const { data } = await client().auth.getSession();
  return data.session;
}

export function onSignedIn(cb: (session: Session) => void): () => void {
  const { data } = client().auth.onAuthStateChange((_event, session) => {
    if (session) cb(session);
  });
  return () => data.subscription.unsubscribe();
}

/** Where Google and the confirmation email send people back to: this page, or the app's deep link. */
function returnUrl(): string {
  return Capacitor.isNativePlatform() ? NATIVE_REDIRECT : window.location.origin + window.location.pathname;
}

export async function signInWithGoogle(): Promise<void> {
  const native = Capacitor.isNativePlatform();
  const { data, error } = await client().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl(), skipBrowserRedirect: native },
  });
  if (error) throw error;
  if (native && data.url) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: data.url });
  }
}

/** Android only: finish a Google sign-in or an email confirmation when the app is reopened through its deep link. */
export async function listenForNativeCallback(onError: (message: string) => void): Promise<void> {
  if (!Capacitor.isNativePlatform() || !supabase) return;
  const { App } = await import('@capacitor/app');
  const { Browser } = await import('@capacitor/browser');
  await App.addListener('appUrlOpen', async ({ url: opened }) => {
    if (!opened.startsWith(NATIVE_REDIRECT)) return;
    await Browser.close().catch(() => {});
    const { code, error } = parseAuthCallback(opened);
    if (error) return onError(error);
    if (!code) return;
    const res = await client().auth.exchangeCodeForSession(code);
    if (res.error) onError(res.error.message);
  });
}

export type SignUpResult = 'verify' | 'exists' | 'signed-in';

export async function signUpWithEmail(email: string, password: string): Promise<SignUpResult> {
  const { data, error } = await client().auth.signUp({ email, password, options: { emailRedirectTo: returnUrl() } });
  if (error) throw error;
  if (data.session) return 'signed-in';
  // Supabase hides whether an address is taken: a taken one comes back with no identities.
  if (data.user && data.user.identities && data.user.identities.length === 0) return 'exists';
  return 'verify';
}

/** Sends the confirmation email again. */
export async function resendConfirmation(email: string): Promise<void> {
  const { error } = await client().auth.resend({ type: 'signup', email, options: { emailRedirectTo: returnUrl() } });
  if (error) throw error;
}

/** Returns 'unverified' when the password is right but the address was never confirmed. */
export async function signInWithEmail(email: string, password: string): Promise<'ok' | 'unverified'> {
  const { error } = await client().auth.signInWithPassword({ email, password });
  if (!error) return 'ok';
  if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) return 'unverified';
  throw error;
}

export async function signOut(): Promise<void> {
  await client().auth.signOut();
}
