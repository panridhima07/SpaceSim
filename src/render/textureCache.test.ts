import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every TextureLoader.load call is recorded so a test can finish (or fail) it by hand.
const pending = vi.hoisted(() => [] as { url: string; onLoad: (t: unknown) => void; onError: (e: unknown) => void }[]);

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeTextureLoader {
    load(url: string, onLoad: (t: unknown) => void, _onProgress: unknown, onError: (e: unknown) => void): void {
      pending.push({ url, onLoad, onError });
    }
  }
  return { ...actual, TextureLoader: FakeTextureLoader };
});

import { clearSharedTextures, loadSharedTexture } from './textureCache';

describe('loadSharedTexture', () => {
  beforeEach(() => {
    pending.length = 0;
    clearSharedTextures();
  });

  it('loads a URL once and hands the same texture to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    loadSharedTexture('earth.jpg', a);
    loadSharedTexture('earth.jpg', b);
    expect(pending).toHaveLength(1);
    expect(a).not.toHaveBeenCalled();

    const tex = new THREE.Texture();
    pending[0].onLoad(tex);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toBe(tex);
    expect(b.mock.calls[0][0]).toBe(tex);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(tex.anisotropy).toBe(4);
  });

  it('calls a late subscriber at once with the cached texture, without a new load', () => {
    loadSharedTexture('sun.jpg', () => {});
    const tex = new THREE.Texture();
    pending[0].onLoad(tex);

    const late = vi.fn();
    loadSharedTexture('sun.jpg', late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0]).toBe(tex);
    expect(pending).toHaveLength(1);
  });

  it('keys by colour space: the same URL in two colour spaces is two textures', () => {
    const srgb = vi.fn();
    const linear = vi.fn();
    loadSharedTexture('bump.jpg', srgb);
    loadSharedTexture('bump.jpg', linear, { colorSpace: THREE.NoColorSpace });
    expect(pending).toHaveLength(2);
    const t0 = new THREE.Texture();
    const t1 = new THREE.Texture();
    pending[0].onLoad(t0);
    pending[1].onLoad(t1);
    expect(srgb.mock.calls[0][0]).toBe(t0);
    expect(linear.mock.calls[0][0]).toBe(t1);
    expect(t0.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t1.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('drops waiting subscribers silently when the load fails', () => {
    const a = vi.fn();
    const b = vi.fn();
    loadSharedTexture('missing.jpg', a);
    loadSharedTexture('missing.jpg', b);
    expect(() => pending[0].onError(new Error('404'))).not.toThrow();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('retries a URL on the next request after a failed load', () => {
    loadSharedTexture('flaky.jpg', () => {});
    pending[0].onError(new Error('network'));

    const again = vi.fn();
    loadSharedTexture('flaky.jpg', again);
    // The failure is forgotten, so the next caller starts a fresh request.
    expect(pending).toHaveLength(2);
    expect(again).not.toHaveBeenCalled();
  });
});
