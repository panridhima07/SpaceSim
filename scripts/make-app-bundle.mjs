// Packs the built website into the zip the Android app downloads to update itself.
// Output: dist/app-update/bundle-<build>.zip and dist/app-update/manifest.json.
//
// Runs in `npm run deploy` between `npm run build` and build-vercel-output.mjs.
// It is NOT part of `npm run build`. The build id is read from dist/build.json
// (written by the build); this script never makes one up.
//
// The zip is deterministic: fixed entry dates, forward-slash names, no directory
// entries, so the same input always gives the same sha256.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const FIXED_DATE = new Date('2020-01-01T00:00:00Z');
const UPDATE_DIR = 'app-update';

function collectFiles(absDir, relDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Relative paths (forward slashes, sorted) of every file under distDir that goes into the bundle: everything except the top-level files `admin.html` and `presentation.html`, anything under the top-level folder `app-update/`, and the admin page's chunks `assets/admin-*`. */
export function listBundleFiles(distDir) {
  return collectFiles(distDir, '', [])
    .filter((rel) => rel !== 'admin.html' && rel !== 'presentation.html' && !rel.startsWith(`${UPDATE_DIR}/`) && !/^assets\/admin-/.test(rel))
    .sort();
}

function readBuildInfo(distDir) {
  const file = path.join(distDir, 'build.json');
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing. Run \`npm run build\` first.`);
  }
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (typeof info.build !== 'string' || !/^\d{14}$/.test(info.build)) {
    throw new Error(`build.json: "build" must be 14 digits (YYYYMMDDHHmmss), got ${JSON.stringify(info.build)}`);
  }
  if (typeof info.version !== 'string') {
    throw new Error(`build.json: "version" must be a string, got ${JSON.stringify(info.version)}`);
  }
  return { build: info.build, version: info.version };
}

/**
 * Builds the zip and the manifest. Returns { manifest, zipPath, manifestPath }.
 * manifest = { build, version, minNativeCode, sha256, file }
 *   build, version: from distDir/build.json (throw Error if the file is missing, build is not 14 digits, or version is not a string)
 *   minNativeCode: the given integer (throw Error if not a non-negative integer)
 *   sha256: lowercase hex SHA-256 of the zip file's bytes (node:crypto)
 *   file: `bundle-${build}.zip` (a plain file name, no slashes)
 * Throws Error if distDir/index.html is missing.
 */
export async function makeBundle({ distDir, minNativeCode }) {
  if (!Number.isInteger(minNativeCode) || minNativeCode < 0) {
    throw new Error(`minNativeCode must be a non-negative integer, got ${JSON.stringify(minNativeCode)}`);
  }
  const { build, version } = readBuildInfo(distDir);
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`${path.join(distDir, 'index.html')} is missing. Run \`npm run build\` first.`);
  }

  // The only deletion allowed: the previous bundle folder.
  const updateDir = path.join(distDir, UPDATE_DIR);
  fs.rmSync(updateDir, { recursive: true, force: true });
  fs.mkdirSync(updateDir, { recursive: true });

  const zip = new JSZip();
  for (const rel of listBundleFiles(distDir)) {
    zip.file(rel, fs.readFileSync(path.join(distDir, ...rel.split('/'))), {
      date: FIXED_DATE,
      createFolders: false,
    });
  }
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  const file = `bundle-${build}.zip`;
  const zipPath = path.join(updateDir, file);
  fs.writeFileSync(zipPath, zipBuffer);

  const manifest = {
    build,
    version,
    minNativeCode,
    sha256: createHash('sha256').update(zipBuffer).digest('hex'),
    file,
  };
  const manifestPath = path.join(updateDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return { manifest, zipPath, manifestPath };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = path.join(root, 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { manifest, zipPath } = await makeBundle({ distDir, minNativeCode: pkg.astra?.minNativeCode });
  const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  const fileCount = listBundleFiles(distDir).length;
  console.log(`Wrote dist/${UPDATE_DIR}/${manifest.file} (${sizeMb} MB, ${fileCount} files) and manifest.json`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
