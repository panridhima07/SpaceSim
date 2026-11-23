// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addExternalPart, addInternalPart, createEmptyDesign, toRocketModel } from '../builder/design';
import { exportRocketModel3D } from './model3d';
import type { RocketModel } from '../types';

function makeTestRocket(): RocketModel {
  let d = createEmptyDesign('Test 3D Rocket');
  const nose = addExternalPart(d, {
    id: '',
    name: 'Nose Cone',
    kind: 'nosecone',
    x: 0,
    length: 0.15,
    density: 1000,
    shape: 'ogive',
    shapeParam: 1,
    baseRadius: 0.025,
    thickness: 0.002,
    color: 0xff4422,
  });
  d = nose.design;

  const body = addExternalPart(d, {
    id: '',
    name: 'Body Tube',
    kind: 'bodytube',
    x: 0,
    length: 0.35,
    density: 680,
    outerRadius: 0.025,
    thickness: 0.001,
    color: 0xffffff,
  });
  d = body.design;

  d = addInternalPart(d, body.id, {
    id: '',
    name: 'Fins',
    kind: 'finset',
    x: 0,
    length: 0.06,
    density: 400,
    count: 3,
    rootChord: 0.06,
    tipChord: 0.03,
    span: 0.04,
    sweepLength: 0.02,
    thickness: 0.003,
    cant: 0,
    bodyRadius: 0.025,
    finShape: 'trapezoid',
    color: 0x2244ff,
  }, 'bottom', 0)!.design;

  return toRocketModel(d);
}

describe('exportRocketModel3D', () => {
  const rocket = makeTestRocket();

  it('exports valid binary GLB starting with glTF magic', async () => {
    const result = await exportRocketModel3D(rocket, 'glb');
    expect(result).toBeInstanceOf(Uint8Array);
    const bytes = result as Uint8Array;
    expect(bytes.byteLength).toBeGreaterThan(100);

    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(magic).toBe('glTF');
  });

  it('exports valid binary STL in millimetres with triangle count > 0', async () => {
    const result = await exportRocketModel3D(rocket, 'stl');
    expect(result).toBeInstanceOf(Uint8Array);
    const bytes = result as Uint8Array;
    expect(bytes.byteLength).toBeGreaterThan(84);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);
    expect(triCount).toBeGreaterThan(0);
    expect(bytes.byteLength).toBe(84 + triCount * 50);

    // Check Y coordinates are in millimetres (~0 down to -500 mm for 0.5 m rocket).
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < triCount; i++) {
      const base = 84 + i * 50;
      for (let v = 0; v < 3; v++) {
        const y = view.getFloat32(base + 12 + v * 12 + 4, true);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    expect(maxY).toBeCloseTo(0, 1);
    expect(minY).toBeCloseTo(-500, 0);
  });

  it('exports valid Wavefront OBJ in millimetres containing v and f lines', async () => {
    const result = await exportRocketModel3D(rocket, 'obj');
    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text.length).toBeGreaterThan(100);
    expect(text).toMatch(/^v\s+/m);
    expect(text).toMatch(/^f\s+/m);
  });
});
