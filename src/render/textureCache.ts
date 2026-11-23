import * as THREE from 'three';

interface Entry {
  texture: THREE.Texture | null;
  waiting: ((t: THREE.Texture) => void)[];
}

const cache = new Map<string, Entry>();
let loader: THREE.TextureLoader | null = null;

/**
 * Loads a texture once per URL (and colour space) and shares it between callers, so the same image
 * is decoded and uploaded to the GPU a single time. Late subscribers are called immediately.
 * Shared textures must never be disposed by an individual user. Load errors are silent.
 */
export function loadSharedTexture(
  url: string,
  onLoad: (t: THREE.Texture) => void,
  opts: { colorSpace?: THREE.ColorSpace } = {},
): void {
  const colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  const key = `${url}|${colorSpace}`;
  let entry = cache.get(key);
  if (entry?.texture) {
    onLoad(entry.texture);
    return;
  }
  if (entry) {
    entry.waiting.push(onLoad);
    return;
  }
  entry = { texture: null, waiting: [onLoad] };
  cache.set(key, entry);
  const e = entry;
  loader ??= new THREE.TextureLoader();
  loader.load(
    url,
    (t) => {
      t.colorSpace = colorSpace;
      t.anisotropy = 4;
      e.texture = t;
      const subs = e.waiting;
      e.waiting = [];
      for (const cb of subs) {
        try {
          cb(t);
        } catch (err) {
          // One subscriber failing must not keep the texture from the others.
          console.error(err);
        }
      }
    },
    undefined,
    () => {
      // Forget the failed load so the next caller tries again (a phone can drop one request).
      e.waiting = [];
      if (cache.get(key) === e) cache.delete(key);
    },
  );
}

/** Test helper: forget all cached textures. */
export function clearSharedTextures(): void {
  cache.clear();
}
