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
// Google Play updates the app itself and forbids any other update path, so the in-app
// "new version" prompt (src/app/appUpdate.ts) is switched off in Play bundles.
if (kind === 'bundle') env.VITE_APP_UPDATE_FEED = 'off';

function run(label, cmd, args, cwd = root) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: win });
  if (r.status !== 0) {
    console.error(`\n${label} failed.`);
    process.exit(r.status ?? 1);
  }
}

run('typecheck + web build', process.execPath, ['scripts/build-parallel.mjs']);
run('copy into Android project', process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android']);
const gradlew = win ? 'gradlew.bat' : './gradlew';
run(
  kind === 'apk' ? 'signed APK' : 'signed app bundle',
  gradlew,
  [kind === 'apk' ? 'assembleRelease' : 'bundleRelease'],
  path.join(root, 'android'),
);

const built =
  kind === 'apk'
    ? path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    : path.join(root, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const outDir = path.join(root, 'release');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `astra-${version}.${kind === 'apk' ? 'apk' : 'aab'}`);
copyFileSync(built, out);
console.log(`\nDone: ${path.relative(root, out)} (${(statSync(out).size / 1e6).toFixed(1)} MB), version ${version}`);
