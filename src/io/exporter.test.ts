// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addExternalPart, createEmptyDesign } from '../builder/design';
import { importDesignJson } from '../builder/storage';
import { parseOrkFile } from '../ork/parser';
import { EXPORT_FORMATS, exportDesign, safeFilename } from './exporter';

function makeSampleDesign() {
  let d = createEmptyDesign('Alpha Explorer!');
  d = addExternalPart(d, {
    id: '',
    name: 'Nose',
    kind: 'nosecone',
    x: 0,
    length: 0.12,
    density: 1000,
    shape: 'ogive',
    shapeParam: 1,
    baseRadius: 0.02,
    thickness: 0.002,
  }).design;
  d = addExternalPart(d, {
    id: '',
    name: 'Body',
    kind: 'bodytube',
    x: 0,
    length: 0.3,
    density: 680,
    outerRadius: 0.02,
    thickness: 0.001,
  }).design;
  return d;
}

describe('exporter', () => {
  it('defines EXPORT_FORMATS in exact order', () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(['ork', 'json', 'glb', 'stl', 'obj']);
    for (const f of EXPORT_FORMATS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.ext).toBe(f.id);
      expect(f.mime.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  it('sanitizes filenames like src/app/main.ts', () => {
    expect(safeFilename('Alpha Explorer!')).toBe('Alpha_Explorer');
    expect(safeFilename('  my-rocket_01  ')).toBe('my-rocket_01');
    expect(safeFilename('')).toBe('rocket');
    expect(safeFilename('!!!')).toBe('rocket');
  });

  it('exports json and round-trips via importDesignJson', async () => {
    const design = makeSampleDesign();
    const { blob, filename } = await exportDesign(design, 'json');
    expect(filename).toBe('Alpha_Explorer.json');
    expect(blob.type).toBe('application/json');
    const parsed = importDesignJson(await blob.text());
    expect(parsed.name).toBe(design.name);
    expect(parsed.stack.length).toBe(design.stack.length);
  });

  it('exports ork and round-trips via parseOrkFile', async () => {
    const design = makeSampleDesign();
    const { blob, filename } = await exportDesign(design, 'ork');
    expect(filename).toBe('Alpha_Explorer.ork');
    expect(blob.type).toBe('application/zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parsed = await parseOrkFile(bytes);
    expect(parsed.name).toBe(design.name);
    expect(parsed.components.length).toBe(2);
  });

  it('exports glb, stl, and obj', async () => {
    const design = makeSampleDesign();

    const glb = await exportDesign(design, 'glb');
    expect(glb.filename).toBe('Alpha_Explorer.glb');
    const glbBytes = new Uint8Array(await glb.blob.arrayBuffer());
    expect(String.fromCharCode(...glbBytes.subarray(0, 4))).toBe('glTF');

    const stl = await exportDesign(design, 'stl');
    expect(stl.filename).toBe('Alpha_Explorer.stl');
    expect(stl.blob.size).toBeGreaterThan(84);

    const obj = await exportDesign(design, 'obj');
    expect(obj.filename).toBe('Alpha_Explorer.obj');
    const objText = await obj.blob.text();
    expect(objText).toMatch(/^v\s+/m);
    expect(objText).toMatch(/^f\s+/m);
  });
});
