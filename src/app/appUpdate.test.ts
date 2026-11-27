import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOWNLOAD_PREFIX,
  isApkUrl,
  isNewer,
  parseVersion,
  rememberedUpdate,
  updateFromRelease,
} from './appUpdate';
import { shareBaseUrl, PUBLIC_SITE_URL } from './native';

describe('parseVersion', () => {
  it('reads tags and plain versions', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2')).toEqual([1, 2, 0]);
    expect(parseVersion(' 2.0.1-beta ')).toEqual([2, 0, 1]);
  });
  it('rejects anything else', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion(12)).toBeNull();
  });
});

describe('isNewer', () => {
  it('compares numerically, not as text', () => {
    expect(isNewer('v1.0.10', '1.0.9')).toBe(true);
    expect(isNewer('1.1.0', '1.0.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.9', '1.0.0')).toBe(false);
    expect(isNewer('nonsense', '1.0.0')).toBe(false);
    // A release is newer than its own beta, not the other way round.
    expect(isNewer('v1.3.0', '1.3.0-beta')).toBe(true);
    expect(isNewer('1.3.0-beta', '1.3.0')).toBe(false);
  });
});

describe('updateFromRelease', () => {
  const apk = 'https://github.com/panridhima07/SpaceSim/releases/download/v1.1.0/astra-1.1.0.apk';
  const page = 'https://github.com/panridhima07/SpaceSim/releases/tag/v1.1.0';
  const release = (over: Record<string, unknown> = {}) => ({
    tag_name: 'v1.1.0',
    html_url: page,
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://github.com/x/notes.txt' },
      { name: 'astra-1.1.0.apk', browser_download_url: apk },
    ],
    ...over,
  });

  it('offers the APK of a newer release', () => {
    expect(updateFromRelease(release(), '1.0.0')).toEqual({ version: '1.1.0', url: apk });
  });
  it('falls back to the release page when there is no APK', () => {
    expect(updateFromRelease(release({ assets: [] }), '1.0.0')).toEqual({ version: '1.1.0', url: page });
  });
  it('ignores the same or an older version, drafts and pre-releases', () => {
    expect(updateFromRelease(release(), '1.1.0')).toBeNull();
    expect(updateFromRelease(release(), '2.0.0')).toBeNull();
    expect(updateFromRelease(release({ draft: true }), '1.0.0')).toBeNull();
    expect(updateFromRelease(release({ prerelease: true }), '1.0.0')).toBeNull();
  });
  it('never returns a link outside github.com', () => {
    const evil = release({
      html_url: 'https://evil.example/x',
      assets: [{ name: 'astra.apk', browser_download_url: 'https://evil.example/astra.apk' }],
    });
    expect(updateFromRelease(evil, '1.0.0')).toBeNull();
  });
  it('survives garbage', () => {
    expect(updateFromRelease(null, '1.0.0')).toBeNull();
    expect(updateFromRelease('<html>', '1.0.0')).toBeNull();
    expect(updateFromRelease({ tag_name: 5 }, '1.0.0')).toBeNull();
  });
  it('ignores an APK and release page that live in another repository', () => {
    const other = release({
      html_url: 'https://github.com/someone-else/repo/releases/tag/v1.1.0',
      assets: [
        {
          name: 'x.apk',
          browser_download_url: 'https://github.com/someone-else/repo/releases/download/v1.1.0/x.apk',
        },
      ],
    });
    expect(updateFromRelease(other, '1.0.0')).toBeNull();
  });
  it('accepts a custom download prefix passed as the third argument', () => {
    const local = {
      tag_name: 'v1.1.1',
      html_url: 'http://10.0.2.2:8787/release',
      assets: [{ name: 'astra-1.1.1.apk', browser_download_url: 'http://10.0.2.2:8787/astra-1.1.1.apk' }],
    };
    expect(updateFromRelease(local, '1.1.0', 'http://10.0.2.2:8787/')).toEqual({
      version: '1.1.1',
      url: 'http://10.0.2.2:8787/astra-1.1.1.apk',
    });
  });
});

describe('rememberedUpdate', () => {
  const apk = 'https://github.com/panridhima07/SpaceSim/releases/download/v1.1.0/astra-1.1.0.apk';
  const raw = (over: Record<string, unknown> = {}) => JSON.stringify({ version: '1.1.0', url: apk, ...over });

  it('returns a stored update that is newer and from the allowed place', () => {
    expect(rememberedUpdate(raw(), '1.0.0')).toEqual({ version: '1.1.0', url: apk });
    expect(rememberedUpdate(raw(), '1.0.0', DEFAULT_DOWNLOAD_PREFIX)).toEqual({ version: '1.1.0', url: apk });
  });
  it('returns null for missing or malformed storage', () => {
    expect(rememberedUpdate(null, '1.0.0')).toBeNull();
    expect(rememberedUpdate('', '1.0.0')).toBeNull();
    expect(rememberedUpdate('not json', '1.0.0')).toBeNull();
  });
  it('returns null when the stored version is equal to or older than the installed one', () => {
    expect(rememberedUpdate(raw(), '1.1.0')).toBeNull();
    expect(rememberedUpdate(raw(), '1.2.0')).toBeNull();
  });
  it('returns null when the url is outside the download prefix', () => {
    expect(rememberedUpdate(raw({ url: 'https://evil.example/astra.apk' }), '1.0.0')).toBeNull();
  });
  it('returns null for non-string fields', () => {
    expect(rememberedUpdate(raw({ version: 110 }), '1.0.0')).toBeNull();
    expect(rememberedUpdate(raw({ url: null }), '1.0.0')).toBeNull();
  });
});

describe('isApkUrl', () => {
  it('is true for APK file links, with any case or query string', () => {
    expect(isApkUrl('https://github.com/panridhima07/SpaceSim/releases/download/v1.1.0/astra-1.1.0.apk')).toBe(true);
    expect(isApkUrl('https://example.org/x.APK?download=1')).toBe(true);
  });
  it('is false for release pages and non-URLs', () => {
    expect(isApkUrl('https://github.com/panridhima07/SpaceSim/releases/tag/v1.1.0')).toBe(false);
    expect(isApkUrl('not a url')).toBe(false);
    expect(isApkUrl('')).toBe(false);
  });
});

describe('DEFAULT_DOWNLOAD_PREFIX', () => {
  it('is the project releases folder on GitHub', () => {
    expect(DEFAULT_DOWNLOAD_PREFIX).toBe('https://github.com/panridhima07/SpaceSim/releases/');
  });
});

describe('shareBaseUrl', () => {
  it('uses the current page on the website', () => {
    expect(shareBaseUrl(false, 'https://example.org/index.html#rocket=abc')).toBe('https://example.org/index.html');
  });
  it('uses the public site inside the app', () => {
    expect(shareBaseUrl(true, 'https://localhost/index.html#rocket=abc')).toBe(`${PUBLIC_SITE_URL}/`);
  });
});
