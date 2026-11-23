import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PART_PRESETS } from '../../builder/parts';
import {
  SOCKET_COLORS,
  buildGhostPart,
  buildJointCollar,
  buildSnapSocket,
  playSnapPop,
} from './connectors';

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
}

function triangles(o: THREE.Object3D): number {
  return meshes(o).reduce((n, m) => {
    const g = m.geometry;
    return n + (g.index ? g.index.count : g.attributes.position.count) / 3;
  }, 0);
}

const KINDS = ['external', 'internal'] as const;
const STATES = ['idle', 'hover', 'mismatch'] as const;

describe('buildSnapSocket', () => {
  it('builds every kind and state under the triangle budget', () => {
    for (const kind of KINDS) for (const state of STATES) {
      const g = buildSnapSocket(0.03, { kind, state });
      expect(meshes(g).length).toBeGreaterThan(5);
      expect(triangles(g)).toBeLessThan(800);
    }
  });

  it('differs between kinds', () => {
    const a = buildSnapSocket(0.03, { kind: 'external', state: 'idle' });
    const b = buildSnapSocket(0.03, { kind: 'internal', state: 'idle' });
    const names = (g: THREE.Object3D) => meshes(g).map((m) => m.name).sort().join(',');
    expect(names(a)).not.toBe(names(b));
  });

  it('uses the state colour', () => {
    for (const state of STATES) {
      const g = buildSnapSocket(0.03, { kind: 'external', state });
      const ring = meshes(g).find((m) => m.name === 'socket-ring')!;
      expect((ring.material as THREE.MeshBasicMaterial).color.getHex()).toBe(SOCKET_COLORS[state]);
    }
    expect(SOCKET_COLORS).toEqual({ idle: 0x4da3ff, hover: 0x3ddc97, mismatch: 0xf2b84b });
  });

  it('scales with radius', () => {
    const size = (r: number) => new THREE.Box3().setFromObject(buildSnapSocket(r, { kind: 'external', state: 'idle' })).getSize(new THREE.Vector3()).x;
    expect(size(0.2)).toBeGreaterThan(size(0.05) * 2);
    expect(size(0.5)).toBeGreaterThan(size(0.2));
  });

  it('survives degenerate radii with a minimum visual size', () => {
    for (const r of [0, -1, NaN, Infinity, 0.005]) for (const kind of KINDS) {
      const g = buildSnapSocket(r, { kind, state: 'idle' });
      const box = new THREE.Box3().setFromObject(g);
      expect(Number.isFinite(box.min.x) && Number.isFinite(box.max.x)).toBe(true);
      expect(box.getSize(new THREE.Vector3()).x).toBeGreaterThan(0.02);
    }
  });
});

describe('buildGhostPart', () => {
  const seen = new Set<string>();
  for (const preset of PART_PRESETS) {
    if (seen.has(preset.category)) continue;
    seen.add(preset.category);
    it(`builds a ghost for ${preset.category} (${preset.presetId})`, () => {
      const c = preset.create();
      c.id = `ghost-${preset.presetId}`;
      const g = buildGhostPart(c);
      const ms = meshes(g).filter((m) => m.name !== 'ghost-edges');
      expect(ms.length).toBeGreaterThan(0);
      const mat = ms[0].material;
      for (const m of ms) expect(m.material).toBe(mat);
      expect((mat as THREE.MeshBasicMaterial).transparent).toBe(true);
      expect((mat as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.35);
      expect((mat as THREE.MeshBasicMaterial).depthWrite).toBe(false);
      expect(g.children.length).toBeGreaterThan(0);
      let edges = 0;
      g.traverse((o) => { if ((o as THREE.LineSegments).isLineSegments) edges++; });
      expect(edges).toBeGreaterThan(0);
      const box = new THREE.Box3().setFromObject(g);
      expect(box.isEmpty()).toBe(false);
      expect(box.max.y).toBeGreaterThan(-0.02);
      expect(box.max.y).toBeLessThan(0.02);
    });
  }

  it('honours colour and opacity', () => {
    const c = PART_PRESETS[0].create();
    c.id = 'x';
    const g = buildGhostPart(c, { color: 0xff0000, opacity: 0.5 });
    const m = meshes(g).find((x) => x.name !== 'ghost-edges')!.material as THREE.MeshBasicMaterial;
    expect(m.color.getHex()).toBe(0xff0000);
    expect(m.opacity).toBe(0.5);
  });
});

describe('buildJointCollar', () => {
  it('stays within the stated dimensions', () => {
    for (const r of [0.01, 0.0248, 0.05, 0.3]) for (const tier of ['best', 'ok', 'bad'] as const) {
      const g = buildJointCollar(r, tier);
      const box = new THREE.Box3().setFromObject(g);
      const size = box.getSize(new THREE.Vector3());
      expect(size.y).toBeCloseTo(Math.max(0.0015, 0.06 * r), 6);
      expect(box.max.x).toBeLessThanOrEqual(r * 1.03 + 1e-6);
      expect(box.max.x).toBeGreaterThan(r);
      expect(triangles(g)).toBeLessThan(800);
    }
  });

  it('survives degenerate radii', () => {
    for (const r of [0, -2, NaN]) {
      const box = new THREE.Box3().setFromObject(buildJointCollar(r));
      expect(Number.isFinite(box.max.x)).toBe(true);
    }
  });
});

describe('playSnapPop', () => {
  const o = new THREE.Object3D();
  it('starts at 1, peaks above 1, ends at exactly 1', () => {
    playSnapPop(o, 0);
    expect(o.scale.x).toBe(1);
    let peak = 0;
    for (let i = 0; i <= 100; i++) {
      playSnapPop(o, i / 100);
      peak = Math.max(peak, o.scale.x);
    }
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1.15);
    playSnapPop(o, 1);
    expect(o.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('clamps out-of-range t', () => {
    playSnapPop(o, 5);
    expect(o.scale.x).toBe(1);
    playSnapPop(o, -3);
    expect(o.scale.x).toBe(1);
    playSnapPop(o, NaN);
    expect(o.scale.x).toBe(1);
  });
});
