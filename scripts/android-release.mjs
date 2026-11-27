// Builds the signed Android release.
//   node scripts/android-release.mjs apk     -> release/astra-<version>.apk  (share directly / GitHub release)
//   node scripts/android-release.mjs bundle  -> release/astra-<version>.aab  (upload to Google Play)
// Needs android/keystore.properties (docs/MOBILE-RELEASE.md, "Signing key"), JDK 17 and the Android SDK.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kind = process.argv[2] ?? 'apk';
if (kind !== 'apk' && kind !== 'bundle') {
  console.error('Usage: node scripts/android-release.mjs apk|bundle');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d{1,2}\.\d{1,2}$/.test(version)) {
  console.error(`package.json version "${version}" must be X.Y.Z with minor and patch below 100 (it becomes versionCode X*10000+Y*100+Z).`);
  process.exit(1);
}
const win = process.platform === 'win32';

if (!existsSync(path.join(root, 'android', 'keystore.properties'))) {
  console.error('android/keystore.properties is missing. Create the signing key first: docs/MOBILE-RELEASE.md, "Signing key".');
  process.exit(1);
}

// Same toolchain defaults as run-android.cmd; anything already set in the environment wins.
const env = { ...process.env };
if (win && env.LOCALAPPDATA) {
  const jdk = path.join(env.LOCALAPPDATA, 'Programs', 'jdk-17');
  const sdk = path.join(env.LOCALAPPDATA, 'Android', 'Sdk');
  if (!env.JAVA_HOME && existsSync(jdk)) env.JAVA_HOME = jdk;
  if (!env.ANDROID_HOME && existsSync(sdk)) env.ANDROID_HOME = sdk;
}
// Google Play updates the app itself and forbids any other update path. Play bundles are the
// Gradle build type "play" (android/app/src/play/AndroidManifest.xml): no permission to install
// APKs, and the app reports itself as a Play build, so it never shows the update bar, whatever
// web content it is running. The feed is also switched off in the web build that ships inside.
if (kind === 'bundle') env.VITE_APP_UPDATE_FEED = 'off';

function run(label, cmd, args, cwd = root) {
  console.log(`\n── ${label} ──`);
  // Only the Gradle batch file needs a shell. Through one, the unquoted path of node.exe
  // ("C:\Program Files\...") breaks at the space.
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: cmd.endsWith('.bat') });
  if (r.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(r.status ?? 1);
  }
}

run('typecheck + web build', process.execPath, ['scripts/build-parallel.mjs']);
run('copy into Android project', process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android']);
// cmd does not always search the current directory, so name the wrapper with an explicit path.
const gradlew = win ? '.\\gradlew.bat' : './gradlew';
run(
  kind === 'apk' ? 'signed APK' : 'signed app bundle',
  gradlew,
  [kind === 'apk' ? 'assembleRelease' : 'bundlePlay'],
  path.join(root, 'android'),
);

const built =
  kind === 'apk'
    ? path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    : path.join(root, 'android', 'app', 'build', 'outputs', 'bundle', 'play', 'app-play.aab');
const outDir = path.join(root, 'release');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `astra-${version}.${kind === 'apk' ? 'apk' : 'aab'}`);
if (!existsSync(built)) {
  console.error(`Expected build output is missing: ${built}`);
  process.exit(1);
}
copyFileSync(built, out);
console.log(`\nDone: ${path.relative(root, out)} (${(statSync(out).size / 1e6).toFixed(1)} MB), version ${version}`);
