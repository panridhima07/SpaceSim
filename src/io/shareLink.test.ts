import { describe, expect, it } from 'vitest';
import { addExternalPart, addInternalPart, createEmptyDesign } from '../builder/design';
import {
  SHARE_HASH_KEY,
  buildShareUrl,
  decodeDesignFromHash,
  encodeDesignToHash,
} from './shareLink';

function makeDesign() {
  let d = createEmptyDesign('Shareable Rocket');
  d = addExternalPart(d, {
    id: '',
    name: 'Nose',
    kind: 'nosecone',
    x: 0,
    length: 0.15,
    density: 1000,
    shape: 'ogive',
    shapeParam: 1,
    baseRadius: 0.025,
    thickness: 0.002,
  }).design;
  const body = addExternalPart(d, {
    id: '',
    name: 'Body',
    kind: 'bodytube',
    x: 0,
    length: 0.35,
    density: 680,
    outerRadius: 0.025,
    thickness: 0.001,
  });
  d = body.design;
  d = addInternalPart(d, body.id, {
    id: '',
    name: 'Fins',
    kind: 'finset',
    x: 0,
    length: 0.07,
    density: 400,
    count: 4,
    rootChord: 0.07,
    tipChord: 0.03,
    span: 0.05,
    sweepLength: 0.02,
    thickness: 0.003,
    cant: 0,
    bodyRadius: 0.025,
    finShape: 'trapezoid',
  }, 'bottom', 0)!.design;
  return d;
}

describe('shareLink', () => {
  it('round-trips a design through encodeDesignToHash and decodeDesignFromHash', async () => {
    const design = makeDesign();
    const hash = await encodeDesignToHash(design);
    expect(hash.startsWith(`#${SHARE_HASH_KEY}=`)).toBe(true);

    const decoded = await decodeDesignFromHash(hash);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(design.id);
    expect(decoded!.name).toBe(design.name);
    expect(decoded!.stack).toEqual(design.stack);
  });

  it('builds a share URL replacing any existing hash', async () => {
    const design = makeDesign();
    const url = await buildShareUrl(design, 'https://astra.example.com/builder#previous');
    expect(url.startsWith(`https://astra.example.com/builder#${SHARE_HASH_KEY}=`)).toBe(true);
    const decoded = await decodeDesignFromHash(url);
    expect(decoded?.name).toBe(design.name);
  });

  it('falls back to uncompressed prefix when CompressionStream is unavailable', async () => {
    const design = makeDesign();
    const g = globalThis as unknown as { CompressionStream?: unknown };
    const orig = g.CompressionStream;
    g.CompressionStream = undefined;
    try {
      const hash = await encodeDesignToHash(design);
      expect(hash.startsWith(`#${SHARE_HASH_KEY}=j`)).toBe(true);
      const decoded = await decodeDesignFromHash(hash);
      expect(decoded?.stack).toEqual(design.stack);
    } finally {
      g.CompressionStream = orig;
    }
  });

  it('returns null without throwing on absent or invalid hashes', async () => {
    expect(await decodeDesignFromHash('')).toBeNull();
    expect(await decodeDesignFromHash('#')).toBeNull();
    expect(await decodeDesignFromHash('#other=123')).toBeNull();
    expect(await decodeDesignFromHash(`#${SHARE_HASH_KEY}=x`)).toBeNull();
    expect(await decodeDesignFromHash(`#${SHARE_HASH_KEY}=z!!!invalid-base64!!!`)).toBeNull();
    expect(await decodeDesignFromHash(`#${SHARE_HASH_KEY}=jbm90LWpzb24`)).toBeNull();
  });

  describe('hostile payloads', () => {
    const b64 = (text: string): string =>
      Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const raw = (obj: unknown): string => `#${SHARE_HASH_KEY}=j${b64(JSON.stringify(obj))}`;
    const body = { kind: 'bodytube', outerRadius: 0.025, length: 0.3, thickness: 0.001, density: 680 };

    it('sanitizes NaN radius, huge fin counts and nodes without a part', async () => {
      const hash = raw({
        format: 'sfb-design',
        design: {
          name: 'Evil',
          stack: [
            { id: 'a', part: { ...body, outerRadius: null } }, // NaN radius survives JSON only as null
            { id: 'b' }, // missing part
            { id: 'c', part: { kind: 'exploit', length: 1 } },
            {
              id: 'd',
              part: body,
              children: [
                { id: 'e', part: { kind: 'finset', rootChord: 0.07, span: 0.05, count: 1e9, bodyRadius: 1e12 } },
                { id: 'f', part: { kind: 'finset', rootChord: 0.07 } },
                null,
              ],
            },
          ],
        },
      });
      const d = await decodeDesignFromHash(hash);
      expect(d).not.toBeNull();
      expect(d!.stack).toHaveLength(1);
      expect(d!.stack[0].children).toHaveLength(1);
      const fin = d!.stack[0].children[0].part;
      expect(fin.kind).toBe('finset');
      if (fin.kind === 'finset') {
        expect(fin.count).toBe(64);
        expect(fin.bodyRadius).toBeLessThanOrEqual(10);
      }
    });

    it('caps a 5000-part stack at 200 parts', async () => {
      const stack = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, part: body, children: [] }));
      const stream = new Blob([JSON.stringify({ name: 'Tall', stack })]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const packed = Buffer.from(await new Response(stream).arrayBuffer()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const d = await decodeDesignFromHash(`#${SHARE_HASH_KEY}=z${packed}`);
      expect(d).not.toBeNull();
      expect(d!.stack).toHaveLength(200);
    });

    it('returns null when nothing valid remains', async () => {
      expect(await decodeDesignFromHash(raw({ stack: [{ part: 5 }, 7] }))).toBeNull();
      expect(await decodeDesignFromHash(raw({ stack: 'nope' }))).toBeNull();
    });

    it('rejects an oversize encoded payload before decoding', async () => {
      const huge = 'A'.repeat(400_001);
      expect(await decodeDesignFromHash(`#${SHARE_HASH_KEY}=j${huge}`)).toBeNull();
      expect(await decodeDesignFromHash(`#${SHARE_HASH_KEY}=z${huge}`)).toBeNull();
    });

    it('rejects a decompression bomb', async () => {
      const g = globalThis as unknown as { CompressionStream?: unknown };
      if (!g.CompressionStream) return;
      const zeros = new Uint8Array(8 * 1024 * 1024);
      const stream = new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(packed.length).toBeLessThan(400_000);
      const payload = Buffer.from(packed).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(await decodeDesignFromHash(`#${SHARE_HASH_KEY}=z${payload}`)).toBeNull();
    });
  });
});
