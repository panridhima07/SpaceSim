# Mobile release guide

The Android app is the website build inside a Capacitor WebView. Web changes now reach installed
apps through website deploys (see "Updates for sideloaded phones" below). A new APK is only
needed for native changes (plugins, permissions, icons, the Android project), or when
`astra.minNativeCode` in `package.json` is raised. Every app build bundles whatever
`npm run build` produces at that moment.

| I want to...                           | Command                    | Result                                  |
| -------------------------------------- | -------------------------- | --------------------------------------- |
| Try it on a USB phone or the emulator  | `run-android.cmd`          | Debug build installed and opened        |
| Get a debug APK file                   | `npm run android:apk`      | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Build the APK I hand to people         | `npm run android:release`  | `release/astra-<version>.apk` (signed)  |
| Build for Google Play                  | `npm run android:bundle`   | `release/astra-<version>.aab` (signed)  |

Needs JDK 17 and the Android SDK (the scripts look in `%LOCALAPPDATA%\Programs\jdk-17` and
`%LOCALAPPDATA%\Android\Sdk` unless `JAVA_HOME` / `ANDROID_HOME` are set).

## Version

There is one version number: `"version"` in `package.json`. The Android `versionName` and
`versionCode` are derived from it (`1.2.3` becomes code `10203`), and the app compares it with
the latest release to decide whether to offer an update. Bump it before every release:

```
npm version patch --no-git-tag-version
```

## Signing key (once)

Android only installs an update over an existing app when both are signed with the same key.
Debug builds are signed with a key that exists only on this PC, so make the release key before
giving the app to anyone. Switching from a debug build to a release build later means
uninstalling first, which wipes guest rockets saved on that phone.

1. Create the key (it asks for a password and a name; run it in the project folder):

   ```
   & "$env:LOCALAPPDATA\Programs\jdk-17\bin\keytool.exe" -genkeypair -v -keystore android\astra-release.jks -alias astra -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Copy `android/keystore.properties.example` to `android/keystore.properties` and put the
   password in `storePassword`. `keyPassword` is only needed if the key has a different password,
   which a key made with the command above does not.
3. Back up `astra-release.jks` and the password somewhere outside this PC. Both files are
   ignored by git on purpose. If the key is lost, the app can never be updated again under the
   same package name (on Google Play, Play App Signing lets you reset an upload key; a
   sideloaded APK has no such rescue).

## First real phone

Before anything else, in the Supabase dashboard open Authentication, URL Configuration and add
`com.astra.spaceflightbuilder://auth-callback` to the redirect URLs. Without it Google sign-in
and email confirmation links cannot return to the app. (Guest mode works regardless.)

**Over USB:** on the phone, Settings, About phone, tap Build number seven times, then Developer
options, USB debugging. Plug in, accept the prompt on the phone and run `run-android.cmd`.

**Without a cable:** send `release/astra-<version>.apk` to the phone (Drive, WhatsApp, the GitHub
release link) and open it. Android asks once to allow installs from that app. Play Protect may
show a warning for an app it has not seen before; choose "Install anyway".

What to check on the phone, since the emulator cannot: Google sign-in round trip, 3D frame rate
in a mission, saving an export (opens the system Save dialog), the Back button, rotation.

## Updates for sideloaded phones

Apps from APK 1.1.0 on get two kinds of update. Web changes arrive by themselves. A new APK is
only needed for native changes.

### Web changes (no taps)

Installed apps read `https://astra-spaceflight.vercel.app/app-update/manifest.json` on every
launch. When it lists a newer build, the app downloads that bundle in the background and switches
to it the next time the app is started (one short extra reload at that start). Apps never switch
while they are only in the background. So a normal website deploy reaches the phones with no taps.
It takes two app starts to show: one to download, one to apply.

`npm run deploy` builds the site, then runs `scripts/make-app-bundle.mjs`. That zips `dist/`
(without `admin.html`) to `dist/app-update/bundle-<build>.zip` and writes
`dist/app-update/manifest.json` (`build`, `version`, `minNativeCode`, `sha256`, `file`). `<build>`
is the UTC build time, YYYYMMDDHHmmss, written by the Vite build to `dist/build.json`. Then it
deploys to Vercel.

- **Safety.** If the new content does not come up within 60 seconds, the app goes back to the
  previous content by itself (the limit is that long because refreshing an expired sign-in on a
  poor connection can take over 30 seconds before anything is shown). If the builder fails to load, it goes back to the content inside
  the APK. A bundle that failed on a phone is not downloaded again on that phone; the next deploy is.
- **Native floor.** `astra.minNativeCode` in `package.json` is the lowest Android version code
  that can run the web content. Raise it to the new version code when web code starts to need
  new native code, then publish a new APK. Older APKs skip those bundles and keep showing the APK
  update bar.
- **Git builds.** A push to `main` makes a Vercel Git build with no bundle. Apps then find no
  manifest and keep what they have.
- **Debug builds.** `run-android.cmd` and `npm run android:apk` take web updates only if built
  with `VITE_APP_BUNDLE_FEED=<manifest URL>`. `VITE_APP_BUNDLE_FEED=off` switches them off in any build.
- **Plugin.** Web updates use `@capgo/capacitor-updater` in manual, self-hosted mode. Its automatic
  updates, stats and channel URLs are off and empty in `capacitor.config.json`, so nothing is sent
  to Capgo.

### New APK (one tap)

Installed apps check the latest GitHub release of `panridhima07/SpaceSim` on start (at most
every 6 hours) and show an "Update" bar when its tag is newer than the installed APK's version.
The bar downloads the APK inside the app, with a progress percentage, and then opens Android's
installer. The first time, Android asks to allow installs from this app. The app opens that
setting, and the person taps Update again afterwards. If anything fails, the app opens the
download in the browser as before. A found update is remembered, so the bar shows again after a
restart.

Downloads are accepted only from `https://github.com/panridhima07/SpaceSim/releases/`. The app
checks that the file is this app and has a higher version code. Android refuses an APK signed
with a different key. Installing a new APK returns the app to the web content inside that APK.

To ship an update:

```
npm version patch --no-git-tag-version
npm run android:release
gh release create v1.1.1 release/astra-1.1.1.apk -R panridhima07/SpaceSim --title "v1.1.1" --notes "What changed"
```

The tag must be `v` plus the version in `package.json`. The first release to publish is
`v1.1.0`, the same way, so there is a download link to share. Phones that have today's debug
build must uninstall it once before installing the signed 1.1.0 (different signing key). That
wipes guest rockets saved on that phone. A different feed can be set at build time with
`VITE_APP_UPDATE_FEED` (code: `src/app/appUpdate.ts`).

## Google Play

1. **Account.** play.google.com/console, 25 USD once, identity verification (takes a few days).
   A personal account must run a closed test with at least 12 testers for 14 days before it
   may publish to production; an organisation account does not. Check the current rule in the
   console.
2. **Blockers in the app today** (Play rejects without these):
   - A privacy policy at a public URL. The app has accounts and optional data sharing, so the
     policy has to say what is stored and why. A page on the Vercel site is enough.
   - Account deletion. Apps with sign-up must let users delete their account in the app and
     through a web link. There is no delete option yet (`src/auth/gate.ts` only has sign out).
3. **Create the app** in the console: name, default language, App (not game) or Game, free.
4. **Store listing:** short and full description, the 512 px icon (`public/icon-512.png`), a
   1024 x 500 feature graphic, at least two phone screenshots.
5. **App content forms:** privacy policy URL, Data safety (email address, user-generated files;
   optional research sharing), content rating questionnaire, target audience, ads: none.
6. **Build:** `npm run android:bundle` and upload `release/astra-<version>.aab` to Internal
   testing first. Accept Play App Signing when asked: Google keeps the real signing key and your
   `.jks` becomes the upload key. The Play build has no APK update bar (its manifest drops the
   `REQUEST_INSTALL_PACKAGES` permission and marks the app as a Play build), but it still takes
   web-content updates.
7. **Google sign-in:** Play re-signs the app, which does not matter for the current browser
   based OAuth flow. Nothing to change.
8. Move Internal testing to Closed testing (the 12 testers), then apply for production. First
   review usually takes a few days. Every later upload needs a higher version.

## Apple App Store

Not possible from this Windows PC: an iOS build needs Xcode, which needs a Mac (your own, a
teammate's, or a cloud Mac such as Codemagic or a GitHub Actions macOS runner). Also needed: the
Apple Developer Program, 99 USD a year.

On the Mac:

```
npm install @capacitor/ios
npx cap add ios
npm run build && npx cap sync ios
npx cap open ios
```

Work the iOS build still needs before it can be submitted:

- **Saving exports.** `FileSaverPlugin.java` is Android only. iOS needs a Swift counterpart (or
  `@capacitor/filesystem` plus `@capacitor/share`), otherwise every export fails.
- **Sign-in return.** Add the URL scheme `com.astra.spaceflightbuilder` to `Info.plist` so the
  Google and email links come back to the app.
- **Sign in with Apple.** Apple requires an equivalent privacy-preserving login next to Google
  sign-in (guideline 4.8). Supabase supports Apple as a provider.
- **Account deletion and a privacy policy,** as for Google Play (guideline 5.1.1).
- **Update bar off:** build with `VITE_APP_UPDATE_FEED=off`.

Then in Xcode: set the team and bundle id, Product, Archive, Distribute to App Store Connect;
test through TestFlight; fill in the listing, privacy labels and screenshots in App Store
Connect; submit for review.

## Usage statistics and admin dashboard (owner setup)

1. In the Supabase dashboard, SQL editor: run `supabase/migrations/0003_usage_and_admin.sql`
   (and `0001_cloud_data.sql`, `0002_training_consent.sql` first if they were never run). It is
   safe to run twice.
2. Add yourself as an admin, in the SQL editor:

   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = '<your sign-in email>'
   on conflict do nothing;
   ```

   (You must have signed in to the site once with that email so the account exists.) To check:
   `select count(*) from public.admins;` should be 1 or more.
3. Supabase, Authentication, URL Configuration: add
   `https://astra-spaceflight.vercel.app/admin.html` to the redirect URLs.
4. Deploy the site (`npm run deploy`), then open
   `https://astra-spaceflight.vercel.app/admin.html` and sign in. (`/admin` redirects there.)

To remove an admin:

```sql
delete from public.admins where user_id = (select id from auth.users where email = '<their sign-in email>');
```

The site and the app count anonymous usage: app opens, flights, missions and imports, per device
per day, for web and Android. Each device has a random id. No IP address, email, user id or
rocket data is stored. Nothing is counted when the browser sends Do Not Track or Global Privacy
Control, on localhost, or in debug builds of the app. At most 5,000 newly seen devices are
counted per day. The dashboard shows 7, 30 or 90 days of opens and devices, app versions in use,
signed-in vs guest, flights, missions, imports, all-time accounts, designs, uploads, sim runs,
and APK downloads per GitHub release. Only accounts listed in the `admins` table can see the
data, and the database enforces this.
