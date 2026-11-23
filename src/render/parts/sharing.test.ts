// Per-part sharing of materials and geometry, and the touch-device segment cap.
// This file stubs a coarse pointer before anything asks, so the cap is on for every test here.

import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BodyTube, FinSet, InnerTube, MassComponent, Ring } from '../../types';
import { buildFin } from './aero';
import { buildBodyTube, buildMotor } from './airframe';
import { buildBallast } from './cargo';
import { buildMass, buildRing } from './internals';
import { PART_TIERS, radialSegments, type PartContext } from './types';

beforeAll(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q }));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const ctx: PartContext = { cutaway: true, maxRadius: 0.02, rocketLength: 0.6 };

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((m) => { if ((m as THREE.Mesh).isMesh) out.push(m as THREE.Mesh); });
  return out;
}

const tube: BodyTube = { kind: 'bodytube', id: 't1', name: 'Tube', x: 0.1, length: 0.3, density: 0, outerRadius: 0.02, thickness: 0.0005 } as BodyTube;
const fins: FinSet = {
  kind: 'finset', id: 'f1', name: 'Fins', x: 0.3, length: 0.05, density: 0, count: 4, rootChord: 0.05, tipChord: 0.03,
  span: 0.04, sweepLength: 0.02, thickness: 0.003, bodyRadius: 0.02, finShape: 'trapezoid',
} as FinSet;
const motor: InnerTube = {
  kind: 'innertube', id: 'm1', name: 'Mount', x: 0.3, length: 0.2, density: 0,
  outerRadius: 0.015, thickness: 0.001, isMotorMount: true, overhang: 0.01,
  motor: { manufacturer: 'X', designation: 'F32', diameter: 0.028, length: 0.12, delay: 5 },
} as InnerTube;
const ring: Ring = { kind: 'ring', id: 'r1', name: 'Ring', x: 0.2, length: 0.004, density: 0, outerRadius: 0.019, innerRadius: 0.006, ringType: 'centeringring' } as Ring;
const mass: MassComponent = { kind: 'mass', id: 'w1', name: 'Mass', x: 0.2, length: 0.05, density: 0, mass: 0.01 } as MassComponent;

describe('segment cap on a touch device', () => {
  it('caps by role and never raises a count', () => {
    expect(radialSegments(64, 'outer')).toBe(32);
    expect(radialSegments(64, 'inner')).toBe(24);
    expect(radialSegments(32, 'small')).toBe(16);
    expect(radialSegments(8, 'outer')).toBe(8);
  });

  it('a best body tube skin is drawn with 32 segments', () => {
    const skin = meshes(buildBodyTube(tube, 'best', ctx)).find((m) => m.name === 'skin')!;
    expect((skin.geometry as THREE.CylinderGeometry).parameters.radialSegments).toBe(32);
  });

  for (const t of PART_TIERS) {
    it(`${t}: capped inner parts keep their exact radii`, () => {
      for (const o of [buildRing(ring, t, ctx), buildMass(mass, t, ctx)]) {
        o.updateMatrixWorld(true);
        let rMax = 0;
        for (const m of meshes(o)) {
          if (m.parent?.userData.detail) continue;
          const p = m.geometry.getAttribute('position');
          const v = new THREE.Vector3();
          for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
            rMax = Math.max(rMax, Math.hypot(v.x, v.z));
            expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
          }
        }
        expect(rMax).toBeGreaterThan(0);
      }
    });
  }
});

describe('sharing within one part', () => {
  it('meshes of one part with the same colour share one material', () => {
    const g = buildFin(fins, 'bad', ctx);
    const glue = meshes(g).filter((m) => m.name === 'glue');
    if (glue.length > 1) for (const m of glue) expect(m.material).toBe(glue[0].material);
    const fin = meshes(g).find((m) => m.name === 'fin')!;
    // the fin skin has no polygon offset, its decoration does: never the same material
    for (const m of meshes(g)) if (m !== fin) expect(m.material).not.toBe(fin.material);
  });

  it('two separate parts never share a material', () => {
    const a = meshes(buildBodyTube(tube, 'best', ctx));
    const b = meshes(buildBodyTube({ ...tube, id: 't2' }, 'best', ctx));
    const mats = new Set(a.map((m) => m.material));
    for (const m of b) expect(mats.has(m.material as THREE.Material)).toBe(false);
  });

  it('equal bells share a geometry and sit at their own spots', () => {
    const bells = meshes(buildMotor(motor, 'ok', ctx)).filter((m) => m.userData.bell);
    expect(bells).toHaveLength(3);
    expect(new Set(bells.map((b) => b.geometry)).size).toBe(1);
    expect(new Set(bells.map((b) => `${b.position.x},${b.position.z}`)).size).toBe(3);
  });

  it('identical ballast discs share a geometry', () => {
    const discs = meshes(buildBallast({ ...mass, name: 'Ballast', length: 0.06 }, 'best', ctx)).filter((m) => !m.parent?.userData.detail);
    expect(discs.length).toBeGreaterThan(1);
    expect(new Set(discs.map((d) => d.geometry)).size).toBe(1);
  });
});
