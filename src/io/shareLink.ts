// URL-hash share link encoder/decoder for rocket designs.
// Uses CompressionStream('deflate-raw') when available, with an uncompressed fallback.

import type { Design } from '../builder/design';
import { exportDesignJson, importDesignJson } from '../builder/storage';
import { MAX_SHARE_ENCODED_CHARS, MAX_SHARE_INFLATED_BYTES, inflateCapped } from './limits';

export const SHARE_HASH_KEY = 'rocket';

const PREFIX_DEFLATE = 'z';
const PREFIX_RAW = 'j';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url: string): Uint8Array {
  const pad = b64url.length % 4 === 0 ? '' : '='.repeat(4 - (b64url.length % 4));
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS = (
    globalThis as unknown as {
      CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new CS('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Inflate with a hard output cap; null when unsupported, corrupt, or over the cap. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return (await inflateCapped(bytes, 'deflate-raw', MAX_SHARE_INFLATED_BYTES)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Encode a Design into a URL hash fragment `#rocket=<payload>`.
 * Uses deflate-raw compression when CompressionStream is available, otherwise uncompressed.
 */
export async function encodeDesignToHash(design: Design): Promise<string> {
  const json = exportDesignJson(design);
  const rawBytes = new TextEncoder().encode(json);
  const compressed = await deflateRaw(rawBytes);
  if (compressed) {
    return `#${SHARE_HASH_KEY}=${PREFIX_DEFLATE}${toBase64Url(compressed)}`;
  }
  return `#${SHARE_HASH_KEY}=${PREFIX_RAW}${toBase64Url(rawBytes)}`;
}

/**
 * Decode a Design from a URL hash fragment (e.g. `#rocket=...`).
 * Returns `null` if absent or invalid; never throws.
 */
export async function decodeDesignFromHash(hash: string): Promise<Design | null> {
  try {
    if (!hash || typeof hash !== 'string') return null;
    const hashIdx = hash.indexOf('#');
    const fragment = hashIdx >= 0 ? hash.slice(hashIdx + 1) : hash;
    if (!fragment) return null;

    const params = new URLSearchParams(fragment);
    const payload = params.get(SHARE_HASH_KEY);
    if (!payload || payload.length < 2) return null;

    const prefix = payload[0];
    const encoded = payload.slice(1);
    if (encoded.length > MAX_SHARE_ENCODED_CHARS) return null;
    const bytes = fromBase64Url(encoded);

    let jsonBytes: Uint8Array;
    if (prefix === PREFIX_DEFLATE) {
      const inflated = await inflateRaw(bytes);
      if (!inflated) return null;
      jsonBytes = inflated;
    } else if (prefix === PREFIX_RAW) {
      if (bytes.length > MAX_SHARE_INFLATED_BYTES) return null;
      jsonBytes = bytes;
    } else {
      return null;
    }

    const text = new TextDecoder().decode(jsonBytes);
    return importDesignJson(text);
  } catch {
    return null;
  }
}

/** Build a full shareable URL by attaching `#rocket=<payload>` to `baseUrl`. */
export async function buildShareUrl(design: Design, baseUrl: string): Promise<string> {
  const hash = await encodeDesignToHash(design);
  const cleanBase = baseUrl.split('#')[0];
  return `${cleanBase}${hash}`;
}
