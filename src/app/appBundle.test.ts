import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { listBundleFiles, makeBundle } from '../../scripts/make-app-bundle.mjs';

const DEFAULT_BUILD_JSON = JSON.stringify({ build: '20261126101500', version: '1.1.0' });

let tmp: string;
let dist: string;

function put(rel: string, data: string | Buffer): void {
  const abs = path.join(dist, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

/** Fake dist folder. Pass buildJson: null to omit build.json, or a string to replace it; index: false omits index.html. */
function writeFakeDist(opts: { buildJson?: string | null; index?: boolean } = {}): void {
  if (opts.index !== false) put('index.html', '<!doctype html><title>ASTRA</title>');
  put('landing.html', '<html>landing</html>');
  put('admin.html', '<html>admin</html>');
  const buildJson = 'buildJson' in opts ? opts.buildJson : DEFAULT_BUILD_JSON;
  if (buildJson !== null && buildJson !== undefined) put('build.json', buildJson);
  put('assets/app-abc.js', 'console.log("app");');
  put('assets/deep/tex.bin', Buffer.from([0, 1, 2, 3, 255]));
  put('app-update/old.zip', 'stale bundle');
}

function sha256Of(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-bundle-'));
  dist = path.join(tmp, 'dist');
  fs.mkdirSync(dist, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listBundleFiles', () => {
  it('excludes admin.html and app-update/, includes nested files, uses forward slashes, is sorted', () => {
    writeFakeDist();
    const files = listBundleFiles(dist);
    expect(files).toEqual([
      'assets/app-abc.js',
      'assets/deep/tex.bin',
      'build.json',
      'index.html',
      'landing.html',
    ]);
    expect(files.some((f) => f.includes('\\'))).toBe(false);
  });
});

describe('makeBundle', () => {
  it('writes the zip and manifest with the right fields and clears the stale app-update folder', async () => {
    writeFakeDist();
    const { manifest, zipPath, manifestPath } = await makeBundle({ distDir: dist, minNativeCode: 10100 });

    expect(manifest.build).toBe('20261126101500');
    expect(manifest.version).toBe('1.1.0');
    expect(manifest.minNativeCode).toBe(10100);
    expect(manifest.file).toBe('bundle-20261126101500.zip');
    expect(manifest.file).not.toContain('/');
    expect(zipPath).toBe(path.join(dist, 'app-update', 'bundle-20261126101500.zip'));
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
    expect(fs.readFileSync(manifestPath, 'utf8').endsWith('\n')).toBe(true);
    expect(fs.existsSync(path.join(dist, 'app-update', 'old.zip'))).toBe(false);
  });

  it('manifest sha256 is the SHA-256 of the zip on disk and is 64 lowercase hex chars', async () => {
    writeFakeDist();
    const { manifest, zipPath } = await makeBundle({ distDir: dist, minNativeCode: 10100 });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sha256).toBe(sha256Of(zipPath));
  });

  it('zip entries match listBundleFiles, use forward slashes, have no directory entries, and round-trip content', async () => {
    writeFakeDist();
    const { zipPath } = await makeBundle({ distDir: dist, minNativeCode: 10100 });
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const names = Object.keys(zip.files).sort();

    expect(names).toEqual(listBundleFiles(dist));
    expect(names.some((n) => n.includes('\\'))).toBe(false);
    for (const name of names) {
      expect(zip.files[name].dir).toBe(false);
    }
    const index = await zip.file('index.html')?.async('string');
    expect(index).toBe(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
  });

  it('gives the same sha256 when run twice on the same input', async () => {
    writeFakeDist();
    const first = await makeBundle({ distDir: dist, minNativeCode: 10100 });
    const second = await makeBundle({ distDir: dist, minNativeCode: 10100 });
    expect(second.manifest.sha256).toBe(first.manifest.sha256);
  });

  it('throws when build.json is missing', async () => {
    writeFakeDist({ buildJson: null });
    await expect(makeBundle({ distDir: dist, minNativeCode: 10100 })).rejects.toThrow(/build\.json/);
  });

  it('throws when build.json has a bad build id', async () => {
    writeFakeDist({ buildJson: JSON.stringify({ build: 'abc', version: '1.1.0' }) });
    await expect(makeBundle({ distDir: dist, minNativeCode: 10100 })).rejects.toThrow(/14 digits/);
  });

  it('throws when build.json version is not a string', async () => {
    writeFakeDist({ buildJson: JSON.stringify({ build: '20261126101500', version: 110 }) });
    await expect(makeBundle({ distDir: dist, minNativeCode: 10100 })).rejects.toThrow(/version/);
  });

  it('throws when index.html is missing', async () => {
    writeFakeDist({ index: false });
    await expect(makeBundle({ distDir: dist, minNativeCode: 10100 })).rejects.toThrow(/index\.html/);
  });

  it('throws when minNativeCode is -1 or 1.5', async () => {
    writeFakeDist();
    await expect(makeBundle({ distDir: dist, minNativeCode: -1 })).rejects.toThrow(/minNativeCode/);
    await expect(makeBundle({ distDir: dist, minNativeCode: 1.5 })).rejects.toThrow(/minNativeCode/);
  });
});
