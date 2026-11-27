import { describe, expect, it } from 'vitest';
import {
  bootAction,
  bundleUrl,
  isBuildId,
  parseFailed,
  parseManifest,
  parsePending,
  shouldDownload,
  type BundleManifest,
  type UpdateState,
} from './liveUpdate';

const manifest: BundleManifest = {
  build: '20261126101500',
  version: '1.1.0',
  minNativeCode: 10100,
  sha256: 'a'.repeat(64),
  file: 'bundle-20261126101500.zip',
};

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  build: '20261125090000',
  nativeCode: 10100,
  failed: [],
  pendingBuild: null,
  ...over,
});

describe('isBuildId', () => {
  it('accepts a 14 digit build id', () => {
    expect(isBuildId('20261126101500')).toBe(true);
  });
  it('rejects wrong lengths, letters, non-strings and empty strings', () => {
    expect(isBuildId('2026112610150')).toBe(false);
    expect(isBuildId('202611261015001')).toBe(false);
    expect(isBuildId('2026112610150a')).toBe(false);
    expect(isBuildId(20261126101500)).toBe(false);
    expect(isBuildId('')).toBe(false);
  });
});

describe('parseManifest', () => {
  it('returns the five fields of a valid manifest and drops extras', () => {
    expect(parseManifest({ ...manifest, extra: 'x' })).toEqual(manifest);
  });
  it('returns null for non-objects', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('{"build":"20261126101500"}')).toBeNull();
  });
  it('returns null when a field is missing', () => {
    const { file: _file, ...noFile } = manifest;
    expect(parseManifest(noFile)).toBeNull();
  });
  it('rejects a malformed build id', () => {
    expect(parseManifest({ ...manifest, build: 'abc' })).toBeNull();
  });
  it('rejects a bad minNativeCode', () => {
    expect(parseManifest({ ...manifest, minNativeCode: '10100' })).toBeNull();
    expect(parseManifest({ ...manifest, minNativeCode: -1 })).toBeNull();
    expect(parseManifest({ ...manifest, minNativeCode: 1.5 })).toBeNull();
  });
  it('rejects a sha256 that is uppercase or the wrong length', () => {
    expect(parseManifest({ ...manifest, sha256: 'A'.repeat(64) })).toBeNull();
    expect(parseManifest({ ...manifest, sha256: 'a'.repeat(63) })).toBeNull();
  });
  it('rejects file names that are not a plain zip file name', () => {
    for (const file of ['../x.zip', 'a/b.zip', 'https://evil.example/x.zip', 'bundle.exe', '.zip', '']) {
      expect(parseManifest({ ...manifest, file })).toBeNull();
    }
  });
});

describe('bundleUrl', () => {
  it('replaces the last path segment of the feed with the file name', () => {
    expect(bundleUrl('https://astra-spaceflight.vercel.app/app-update/manifest.json', 'bundle-1.zip')).toBe(
      'https://astra-spaceflight.vercel.app/app-update/bundle-1.zip',
    );
  });
  it('does not carry over a query string from the feed', () => {
    expect(bundleUrl('https://astra-spaceflight.vercel.app/app-update/manifest.json?v=2#x', 'bundle-1.zip')).toBe(
      'https://astra-spaceflight.vercel.app/app-update/bundle-1.zip',
    );
  });
  it('refuses http unless allowed', () => {
    const feed = 'http://10.0.2.2:8787/app-update/manifest.json';
    expect(bundleUrl(feed, 'bundle-1.zip')).toBeNull();
    expect(bundleUrl(feed, 'bundle-1.zip', true)).toBe('http://10.0.2.2:8787/app-update/bundle-1.zip');
  });
  it('returns null for a feed that is not a URL', () => {
    expect(bundleUrl('not a url', 'bundle-1.zip')).toBeNull();
  });
});

describe('shouldDownload', () => {
  it('is true for a newer manifest the device can run and has not failed or fetched', () => {
    expect(shouldDownload(manifest, state())).toBe(true);
  });
  it('is false for the same build', () => {
    expect(shouldDownload(manifest, state({ build: manifest.build }))).toBe(false);
  });
  it('is false for an older build', () => {
    expect(shouldDownload(manifest, state({ build: '20261127000000' }))).toBe(false);
  });
  it('is false when the running build is unknown', () => {
    expect(shouldDownload(manifest, state({ build: '' }))).toBe(false);
  });
  it('depends on the native code version', () => {
    expect(shouldDownload({ ...manifest, minNativeCode: 10101 }, state({ nativeCode: 10100 }))).toBe(false);
    expect(shouldDownload({ ...manifest, minNativeCode: 10100 }, state({ nativeCode: 10100 }))).toBe(true);
  });
  it('is false for a build that failed on this device', () => {
    expect(shouldDownload(manifest, state({ failed: [manifest.build] }))).toBe(false);
  });
  it('is false when that build is already pending', () => {
    expect(shouldDownload(manifest, state({ pendingBuild: manifest.build }))).toBe(false);
  });
  it('is true when a different, older build is pending', () => {
    expect(shouldDownload(manifest, state({ pendingBuild: '20261126090000' }))).toBe(true);
  });
});

describe('bootAction', () => {
  const build = '20261125090000';
  const pending = { id: 'abc', build: '20261126101500' };

  it('does nothing when nothing is pending or applying', () => {
    expect(bootAction(build, null, null, [])).toEqual({ kind: 'none' });
  });
  it('does not mark failed when the applying build is the running one', () => {
    expect(bootAction(build, null, build, [])).toEqual({ kind: 'none' });
  });
  it('marks the applying build failed when a different build is running', () => {
    expect(bootAction(build, null, '20261126101500', [])).toEqual({ kind: 'mark-failed', build: '20261126101500' });
    expect(bootAction(build, pending, '20261126101500', [])).toEqual({ kind: 'mark-failed', build: '20261126101500' });
  });
  it('applies a newer pending bundle that has not failed', () => {
    expect(bootAction(build, pending, null, [])).toEqual({ kind: 'apply', pending });
  });
  it('drops a pending bundle with the same build as the running one', () => {
    expect(bootAction(build, { id: 'abc', build }, null, [])).toEqual({ kind: 'drop-pending' });
  });
  it('drops a pending bundle that is older', () => {
    expect(bootAction(build, { id: 'abc', build: '20261124000000' }, null, [])).toEqual({ kind: 'drop-pending' });
  });
  it('drops a pending bundle whose build failed before', () => {
    expect(bootAction(build, pending, null, [pending.build])).toEqual({ kind: 'drop-pending' });
  });
  it('drops a pending bundle when the running build is unknown', () => {
    expect(bootAction('', pending, null, [])).toEqual({ kind: 'drop-pending' });
  });
});

describe('parsePending', () => {
  it('reads a valid pending record', () => {
    expect(parsePending('{"id":"abc","build":"20261126101500"}')).toEqual({ id: 'abc', build: '20261126101500' });
  });
  it('returns null for missing or malformed records', () => {
    expect(parsePending(null)).toBeNull();
    expect(parsePending('')).toBeNull();
    expect(parsePending('not json')).toBeNull();
    expect(parsePending('{"build":"20261126101500"}')).toBeNull();
    expect(parsePending('{"id":"","build":"20261126101500"}')).toBeNull();
    expect(parsePending('{"id":"abc","build":"bad"}')).toBeNull();
    expect(parsePending(JSON.stringify({ id: 'a'.repeat(65), build: '20261126101500' }))).toBeNull();
  });
});

describe('parseFailed', () => {
  it('keeps only valid build ids', () => {
    expect(parseFailed('["20261126101500","junk",5]')).toEqual(['20261126101500']);
  });
  it('returns an empty list for missing, malformed or non-list values', () => {
    expect(parseFailed(null)).toEqual([]);
    expect(parseFailed('not json')).toEqual([]);
    expect(parseFailed('{}')).toEqual([]);
  });
  it('keeps only the last 20 of a long list', () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(20261126100000 + i));
    expect(parseFailed(JSON.stringify(ids))).toEqual(ids.slice(-20));
  });
});
