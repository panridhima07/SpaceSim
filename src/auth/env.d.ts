// Build-time settings. Set them in .env (see .env.example).
interface ImportMetaEnv {
  /** Read by src/auth/client.ts. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Server stress-test endpoint, when it is not same-origin (src/cloud/remoteSim.ts). */
  readonly VITE_SIM_ENDPOINT?: string;
  /** Public website, used for share links made inside the Android app (src/app/native.ts). */
  readonly VITE_PUBLIC_SITE_URL?: string;
  /** Android update feed URL, or "off" for Google Play builds (src/app/appUpdate.ts). */
  readonly VITE_APP_UPDATE_FEED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
