import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  TERRAIN_RADIUS_M,
  PAD_GROUND_Y,
  SEA_LEVEL_Y,
  fbm,
  coastX,
  sampleTerrain,
  terrainHeightAt,
  ringRadius,
  buildPadTerrain,
} from './padTerrain';

const EARTH_R = 6_371_000;
const RINGS = 280; // keep in step with padTerrain.ts
const SEGMENTS = 340; // keep in step with padTerrain.ts

describe('fbm', () => {
  it('stays in [0, 1) over a grid of points', () => {
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        const v = fbm(i * 0.37, j * 0.91, 5, 1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('is deterministic for the same inputs', () => {
    expect(fbm(12.5, -3.25, 4, 7)).toBe(fbm(12.5, -3.25, 4, 7));
    expect(fbm(0.1, 0.2)).toBe(fbm(0.1, 0.2));
  });

  it('depends on the seed', () => {
    const a = fbm(10.3, 4.7, 4, 1);
    const b = fbm(10.3, 4.7, 4, 99);
    expect(a).not.toBe(b);
  });
});

describe('coastX', () => {
  it('places the shoreline east of the pad for a range of z', () => {
    for (let z = -20_000; z <= 20_000; z += 1_000) {
      expect(coastX(z)).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    expect(coastX(1234)).toBe(coastX(1234));
  });
});

describe('sampleTerrain', () => {
  it('far east (x = +30 km) is under water, offshore of the coast', () => {
    const s = sampleTerrain(30_000, 0);
    expect(s.coast).toBeGreaterThan(0);
    expect(s.height).toBeLessThan(0);
    expect(s.lagoon).toBe(0);
  });

  it('far west (x = -30 km) is inland land', () => {
    const s = sampleTerrain(-30_000, 0);
    expect(s.coast).toBeLessThan(0);
    expect(s.height).toBeGreaterThan(0);
  });

  it('coast is x minus the shoreline position', () => {
    const z = 3000;
    const s = sampleTerrain(500, z);
    expect(s.coast).toBeCloseTo(500 - coastX(z), 9);
  });
});

describe('terrainHeightAt', () => {
  it('is exactly the pad ground height at the origin', () => {
    expect(Math.abs(terrainHeightAt(0, 0) - PAD_GROUND_Y)).toBeLessThan(1e-6);
  });

  it('stays within 0.01 m of the pad ground for points within 300 m', () => {
    const pts: [number, number][] = [
      [300, 0],
      [0, -300],
      [-212, 212],
      [150, 150],
      [-100, 40],
    ];
    for (const [x, z] of pts) {
      expect(Math.abs(terrainHeightAt(x, z) - PAD_GROUND_Y)).toBeLessThan(0.01);
    }
  });

  it('drops by the Earth-curvature term r^2 / (2R) far out on open ground', () => {
    // Beyond the pad flattening and before the skirt, the height is the raw field minus curvature.
    for (const [x, z] of [[-8000, 3000], [5000, -9000], [-20_000, 0]] as const) {
      const r = Math.hypot(x, z);
      const expected = SEA_LEVEL_Y + sampleTerrain(x, z).height - (r * r) / (2 * EARTH_R);
      expect(Math.abs(terrainHeightAt(x, z) - expected)).toBeLessThan(1e-6);
    }
  });

  it('the skirt makes the rim more than 1500 m below the unskirted surface', () => {
    const x = -TERRAIN_RADIUS_M * 0.8, z = TERRAIN_RADIUS_M * 0.6; // r = TERRAIN_RADIUS_M
    const r = Math.hypot(x, z);
    expect(r).toBeCloseTo(TERRAIN_RADIUS_M, 3);
    const unskirted = SEA_LEVEL_Y + sampleTerrain(x, z).height - (r * r) / (2 * EARTH_R);
    const drop = unskirted - terrainHeightAt(x, z);
    expect(drop).toBeGreaterThan(1500);
  });
});

describe('ringRadius', () => {
  it('ring 0 is the centre point', () => {
    expect(ringRadius(0)).toBe(0);
  });

  it('is strictly increasing across all rings', () => {
    let prev = ringRadius(0);
    for (let i = 1; i <= RINGS; i++) {
      const r = ringRadius(i);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it('the outer ring reaches TERRAIN_RADIUS_M', () => {
    expect(ringRadius(RINGS)).toBeCloseTo(TERRAIN_RADIUS_M, 3);
  });
});

/** Reads the shoreline lookup the way the shader does: nearest texel centres, then a linear lerp. */
function lutAt(lut: Float32Array, z: number, channel: number): number {
  const N = 4096; // keep in step with SHORE_LUT_N in padTerrain.ts
  const f = Math.min(N - 1, Math.max(0, (z + TERRAIN_RADIUS_M) * (N / (2 * TERRAIN_RADIUS_M)) - 0.5));
  const i0 = Math.floor(f);
  const t = f - i0;
  const i1 = Math.min(N - 1, i0 + 1);
  return lut[i0 * 4 + channel] * (1 - t) + lut[i1 * 4 + channel] * t;
}

describe('shoreline lookup texture', () => {
  it('matches coastX within 1 m at a range of z', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 10, spaceport: false });
    try {
      const lut = pt.land.userData.shoreLut as Float32Array;
      expect(lut.length).toBe(4096 * 4);
      for (const z of [-140_000, -20_000, -3000, 0, 1234.5, 7777, 25_000, 130_000]) {
        expect(Math.abs(lutAt(lut, z, 0) - coastX(z)), `z=${z}`).toBeLessThan(1);
      }
    } finally {
      pt.dispose();
    }
  });

  it('holds a sensible lagoon centre, half-width and along mask', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 10, spaceport: false });
    try {
      const lut = pt.land.userData.shoreLut as Float32Array;
      // Centre about 9 km west of the pad and half-width 2.6 to 4.4 km (see lagoon terms).
      expect(Math.abs(lutAt(lut, 0, 1) + 9000)).toBeLessThan(2601);
      const hw = lutAt(lut, 0, 2);
      expect(hw).toBeGreaterThanOrEqual(2600);
      expect(hw).toBeLessThanOrEqual(4400);
      expect(lutAt(lut, 0, 3)).toBeCloseTo(1, 6);
      expect(lutAt(lut, -100_000, 3)).toBeCloseTo(0, 6);
    } finally {
      pt.dispose();
    }
  });
});

describe('shoreline mesh heights', () => {
  it('land just inland of the shore is above the water plane and water just offshore is below it', () => {
    const z = 0;
    const c = coastX(z);
    const waterPlane = SEA_LEVEL_Y - 0.4; // the water mesh sits 0.4 m under sea level
    const at = (x: number) => {
      const r = Math.hypot(x, z);
      return terrainHeightAt(x, z) + (r * r) / (2 * EARTH_R); // undo the curvature drop
    };
    for (const x of [c - 50, c - 120]) expect(at(x), `land x=${x}`).toBeGreaterThan(waterPlane);
    for (const x of [c + 50, c + 120]) expect(at(x), `water x=${x}`).toBeLessThan(waterPlane);
  });
});

describe('buildPadTerrain', () => {
  it('builds land and water meshes inside a group', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 200 });
    try {
      expect(pt.group).toBeInstanceOf(THREE.Group);
      const land = pt.group.getObjectByName('terrain-land');
      const water = pt.group.getObjectByName('terrain-water');
      expect(land).toBeInstanceOf(THREE.Mesh);
      expect(water).toBeInstanceOf(THREE.Mesh);
      expect(pt.land).toBe(land);
      expect(pt.water).toBe(water);
    } finally {
      pt.dispose();
    }
  });

  it('land geometry has matching vertex counts for every attribute', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 200 });
    try {
      const geo = pt.land.geometry as THREE.BufferGeometry;
      const expectedVerts = 1 + RINGS * SEGMENTS;
      for (const name of ['position', 'color', 'uv', 'rim', 'aField', 'aGlobeW']) {
        const attr = geo.getAttribute(name);
        expect(attr, name).toBeDefined();
        expect(attr.count, name).toBe(expectedVerts);
      }
    } finally {
      pt.dispose();
    }
  });

  it('water geometry shares the same grid as the land', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 50 });
    try {
      const landGeo = pt.land.geometry as THREE.BufferGeometry;
      const waterGeo = pt.water.geometry as THREE.BufferGeometry;
      expect(waterGeo.getAttribute('position').count).toBe(landGeo.getAttribute('position').count);
    } finally {
      pt.dispose();
    }
  });

  it('update() and dispose() do not throw', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 200 });
    expect(() => pt.update(12.5, 1_000)).not.toThrow();
    expect(() => pt.update(20_000.25, 100_000)).not.toThrow();
    expect(() => pt.dispose()).not.toThrow();
  });

  it('blendGlobe is a no-op without a DOM and does not throw', { timeout: 30_000 }, () => {
    const pt = buildPadTerrain({ trees: 20 });
    try {
      const fake = { width: 4, height: 2 } as unknown as CanvasImageSource & { width: number; height: number };
      expect(() => pt.blendGlobe(fake, new THREE.Matrix4())).not.toThrow();
    } finally {
      pt.dispose();
    }
  });
});
