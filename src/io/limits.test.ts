import { describe, expect, it } from 'vitest';
import {
  MAX_INFLATED_BYTES,
  assertSafeXmlText,
  clampCount,
  readStreamCapped,
  readZipEntry,
  sanitizeDesignObject,
} from './limits';

describe('limits', () => {
  it('clampCount keeps counts in 1..64 and falls back for non-finite input', () => {
    expect(clampCount(3)).toBe(3);
    expect(clampCount(1e9)).toBe(64);
    expect(clampCount(-5)).toBe(1);
    expect(clampCount(NaN, 3)).toBe(3);
    expect(clampCount(undefined, 6)).toBe(6);
  });

  it('assertSafeXmlText rejects DOCTYPE, ENTITY and oversize text', () => {
    expect(() => assertSafeXmlText('<a/>')).not.toThrow();
    expect(() => assertSafeXmlText('<!DOCTYPE a><a/>')).toThrow(/DOCTYPE/);
    expect(() => assertSafeXmlText('<a><!entity x "y"></a>')).toThrow(/ENTITY/);
    expect(() => assertSafeXmlText('x'.repeat(20 * 1024 * 1024 + 1))).toThrow(/too large/);
  });

  it('readStreamCapped aborts once the cap is exceeded', async () => {
    const chunk = new Uint8Array(1000);
    const make = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        pull(c) {
          c.enqueue(chunk);
        },
      });
    await expect(readStreamCapped(make(), 5000)).rejects.toThrow(/too large/);
    const finite = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk);
        c.close();
      },
    });
    expect((await readStreamCapped(finite, 5000)).length).toBe(1000);
  });

  it('readZipEntry checks the declared size before inflating, and the real size after', async () => {
    let inflated = false;
    const lying = {
      name: 'a',
      _data: { uncompressedSize: MAX_INFLATED_BYTES + 1 },
      async: async () => {
        inflated = true;
        return '';
      },
    };
    await expect(readZipEntry(lying as never, { used: 0 }, 'string')).rejects.toThrow(/allowed size/);
    expect(inflated).toBe(false);
    const big = { name: 'b', async: async () => 'x'.repeat(100) };
    await expect(readZipEntry(big as never, { used: MAX_INFLATED_BYTES - 10 }, 'string')).rejects.toThrow(/allowed size/);
    expect(await readZipEntry(big as never, { used: 0 }, 'string')).toHaveLength(100);
  });

  it('sanitizeDesignObject drops parts without a valid kind and makes numbers finite', () => {
    const warnings: string[] = [];
    const d = sanitizeDesignObject(
      {
        stack: [
          { id: 'a', part: { kind: 'bodytube', length: Infinity, outerRadius: 0.02 } },
          { id: 'b', part: { kind: 'bodytube', length: 0.2, outerRadius: 0.02, density: NaN, x: NaN } },
        ],
        nextId: 1e300,
      },
      'Fallback',
      warnings,
    );
    expect(d.stack).toHaveLength(1);
    expect(Number.isFinite(d.stack[0].part.density)).toBe(true);
    expect(d.stack[0].part.x).toBe(0);
    expect(d.nextId).toBeLessThanOrEqual(1e9);
    expect(d.name).toBe('Fallback');
  });
});
