# Design: app auto-update and admin dashboard (2026-11-26)

Status: approved 2026-11-26 after review; review findings folded in below.

## Intent

1. The sideloaded Android app keeps itself current. Web changes arrive with no taps; native
   changes need one "Install" tap.
2. A private dashboard shows how the website and the Android app are used.

## Today

- `src/app/appUpdate.ts` shows an "Update" bar when the latest GitHub release of
  `panridhima07/SpaceSim` is newer, and opens the APK in the browser. The repo has no releases.
- No release signing key on this PC (`android/keystore.properties` missing).
- Nothing records visits or app opens. The database holds profiles, designs, rocket files,
  import corrections and sim runs, each readable only by its owner.
- Site and app are the same `vite build` output. `npm run deploy` builds locally and ships it.

## Goals

- A deploy of the website is picked up by installed apps on a following launch.
- A new APK release is downloaded inside the app and handed to Android's installer.
- A bad web update never leaves the app unusable.
- Only listed admin accounts can read statistics.

## Non-goals

Silent APK install (Android forbids it), iOS, publishing to Google Play, third-party analytics,
viewing individual users or their rockets.

## Anti-goals

Anyone but an admin reading stats; personal data in usage records; an update path that runs code
from anywhere other than our own site or our GitHub releases; slower or blocked app startup.

## Approaches

Updates:
1. **Web-content updates by plugin + in-app APK installer (picked).** No taps for normal
   changes, works offline, one new dependency and a small native plugin.
2. APK download only. Simpler, but every change needs a release and a tap.
3. Point the app at the live website (`server.url`). No update code, but no offline use and a
   broken deploy breaks every phone at once.

Stats:
1. **Own anonymous daily counters in Supabase (picked).** Covers web, app and guests.
2. Database tables only. No visit or app-open numbers.
3. Vercel Web Analytics. Does not see the app and needs a server-held token to display.

## A. Web-content updates

- Plugin: `@capgo/capacitor-updater` 8.x (MPL-2.0), self-hosted, manual mode. Config:
  `autoUpdate: false`, empty `statsUrl`, `updateUrl` and `channelUrl` so nothing is sent to
  Capgo, `appReadyTimeout: 60000` (supabase-js retries an expired session for about 30 s before
  the first screen can show; a shorter limit would roll back a good update on a poor connection).
- Build id: UTC `YYYYMMDDHHmmss`, stamped into every build as `__BUILD_ID__`. One source: Vite
  makes it and also writes `dist/build.json`; the bundle script reads that file and never makes
  its own, or every launch would download the same bundle again.
- `scripts/make-app-bundle.mjs`, run by `npm run deploy` after the build: zips `dist/` (without
  the admin page and without `app-update/`) to `dist/app-update/bundle-<build>.zip` and writes
  `dist/app-update/manifest.json`: `{ build, version, minNativeCode, sha256, file }`.
  The manifest is served `no-cache`. Zip entry names use forward slashes (the plugin rejects
  backslashes; this is a Windows build machine). Order in `npm run deploy`: build, bundle
  script, `build-vercel-output.mjs`. The script is not part of `npm run build`.
- `minNativeCode` comes from `package.json` (`astra.minNativeCode`); raise it when web code
  needs new native code, so older APKs skip that bundle.
- App (`src/app/liveUpdate.ts`, native only): on each launch fetch the manifest from
  `https://astra-spaceflight.vercel.app/app-update/manifest.json` (override for testing:
  `VITE_APP_BUNDLE_FEED`, `off` disables). If `build` is greater than its own, `minNativeCode`
  is satisfied and `file` is a plain file name beside the manifest: download, verify the
  checksum, queue it. All failures are silent. The manifest is fetched with `CapacitorHttp`
  (as `appUpdate.ts` does): the page's CSP `connect-src` does not list the website, so a plain
  `fetch` from `https://localhost` is blocked. The checksum is the lowercase hex SHA-256 of the
  zip; the plugin requires it and checks it itself.
- The check starts in `boot.ts` before the sign-in gate, without blocking it, so a fixed deploy
  can always reach a phone.
- A queued bundle takes effect only when the page boots (cold start, or the app's own page
  loads), never while the app is only in the background: opening Google sign-in or a Save
  dialog must not reload the page. Do NOT use `next()`, with or without a `kill` delay: in
  8.54.2 the plugin applies a "next" bundle only from `appMovedToBackground()` (never at
  launch), and the `kill` condition is cleared at the next launch, so the bundle would be
  applied by a background reload one launch later. Instead: after `download()` store the
  returned bundle id on the device; at the very start of `boot.ts`, if a stored id exists and
  is not `current().bundle.id`, call `set({ id })` (one extra reload at that launch, before
  anything is on screen). Confirm on the emulator.
- Rollback: the app calls `notifyAppReady()` once its first screen (sign-in or builder) has
  rendered; a bundle that never gets there is reverted by the plugin. If the builder then fails
  to load, the app reverts to the APK's built-in content itself (`reset()`). A bundle that
  failed either way is not downloaded again: the app keeps its own list of failed build ids on
  the device, because the plugin deletes a failed bundle's record and would download the same
  version again. Installing a new APK (higher version code) also returns to the built-in
  content.
- Off in debug builds of the app unless `VITE_APP_BUNDLE_FEED` is set at build time: a debug
  rebuild with the same version code would otherwise keep showing an older downloaded bundle.
- A downloaded bundle that has no Supabase configuration counts as failed and is reverted.
- A push to `main` makes a Vercel Git build without env vars and without a bundle; apps then
  find no manifest and keep what they have.

## B. APK updates

- Feed stays the latest GitHub release; the bar stays. It compares the release with the
  installed APK's version (`App.getInfo()`), not the version inside the web content, which a
  web update changes.
- New native plugin `ApkUpdaterPlugin.java` (same pattern as `FileSaverPlugin.java`):
  download over HTTPS from GitHub into the app cache with progress, check the package name is
  ours and the version code is higher, then open Android's installer through the FileProvider.
  If "install unknown apps" is not yet allowed, open that setting and let the person retry.
  The download URL must start with the repository's release path; redirects are followed over
  HTTPS only (GitHub serves assets from another host), and the final host is not checked: the
  package name, version code and Android's signature check are what protect the install.
  The found update is remembered on the device, so the bar shows again after a restart inside
  the 6 hour check interval, and an APK already downloaded is reused.
  Android itself refuses an APK signed with a different key.
- Any failure falls back to today's behaviour (open the link in the browser).
- Play builds (`npm run android:bundle`) are a Gradle build type `play` (release plus a manifest
  overlay that removes `REQUEST_INSTALL_PACKAGES` and sets a `astra.playBuild` flag), and the
  native side reports itself as a Play build. Debug builds are detected with `FLAG_DEBUGGABLE`. The app then shows no update bar at all, whatever web content
  it is running. Play builds still take web-content updates (owner decision).
- Version goes to 1.1.0 with this change.

## C. Usage counting

- Migration `0003_usage_and_admin.sql`:
  - `usage_daily(day, install_id uuid, platform, event, app_version, native_version, signed_in,
    count)`, primary key `(day, install_id, platform, event)`. Days are UTC. Row level security
    on, no direct access.
  - `log_usage(install_id, platform, event, app_version, native_version)`, security definer,
    callable by anyone: checks allowed values, takes `signed_in` from the session (not the
    caller), takes the day from the server, counts at most 1000 per row per day, and adds at
    most 5,000 newly seen devices per day (counter table `usage_day_devices`; over the cap the call
    is dropped silently), so made-up ids cannot fill the database.
  - Grants are explicit: `usage` on schema `public` to `anon` (0001 gives it only to signed-in
    users), `log_usage` executable by `anon` and `authenticated`, `admin_stats` by
    `authenticated` only, both revoked from `public`; both functions `security definer` with
    `search_path = ''`; `usage_daily`, `usage_day_devices` and `admins` revoked from clients.
  - `app_version` is the web content's version; `native_version` is the installed APK's (empty
    on the web). "App versions in use" shows the APK version for Android.
- Events: `open` (once per browser session or app launch, not per page), `flight`, `mission`, `import`.
  Platform: `web` or `android`.
- `src/cloud/usage.ts`: random install id kept on the device; fire and forget. Off when the
  browser sends Do Not Track or Global Privacy Control, on a website served from localhost, and
  in debug builds of the app (the app itself is served from `https://localhost`, so the host
  name only rules out the website).
- Stored: no IP, email, user id or rocket data. The sign-in card says anonymous usage counts
  are collected.
- Known limit: someone using the public key with made-up ids can inflate the numbers, or use up
  a day's 5,000 new-device allowance so that later new devices are not counted that day.

## D. Admin dashboard

- `admin.html` + `src/admin/`, at `/admin.html` on the website (`/admin` redirects to it: the
  prebuilt Vercel output has no clean URLs, so `scripts/build-vercel-output.mjs` needs that
  route, and `admin.html` must be added to the Vite build inputs). Not linked from the app.
  Sign in with Google or email; no guest option, so it has its own small sign-in form on
  `src/auth/client.ts` and does not use `requireAuth` (which offers guest and sign-up).
- Table `admins(user_id)`, not reachable by clients. `admin_stats(days)`, security definer,
  raises unless the caller is listed; returns totals and daily series only. Accounts are
  counted from `auth.users` (a `profiles` row exists only after the consent choice).
- Shows, for 7 / 30 / 90 days, web and Android side by side: opens and unique devices per day,
  app versions in use, signed-in vs guest, flights, missions, imports; all-time accounts,
  designs, uploads and sim runs (by kind and where they ran); APK downloads per release
  (GitHub public API).
- Charts drawn as inline SVG, no chart library. Content-Security-Policy allows
  `api.github.com` on this page only (the CSP builder in `vite.config.ts` takes the page).
- Not an admin, not signed in, migration missing, GitHub unreachable: each has a plain message.

## Steps only the owner can do

0. Accepted: one brief reload at launch applies a web update; 5,000 new devices counted per
   day at most; Play builds take web updates and show no APK bar.
1. Run `0003_usage_and_admin.sql` (and `0001`, `0002` if never applied) in the Supabase SQL
   editor.
2. Add yourself: `insert into public.admins select id from auth.users where email = '<your sign-in email>';`
3. Add `https://astra-spaceflight.vercel.app/admin.html` to Supabase redirect URLs.
4. Create the signing key (`docs/MOBILE-RELEASE.md`) and back it up.
5. Ask for a deploy; publish the first GitHub release.

Phones with today's debug APK must uninstall it before installing the signed one.

## Checks

Unit tests for the update decision, bundle script, usage client and dashboard data shaping;
typecheck, tests, web build, debug APK. Both update flows tried on the emulator. The SQL stays
unverified until it runs on the real project.

## Left to the builder

File layout inside `src/admin/`, visual design (follow the app's existing look), chart details,
test seams.
