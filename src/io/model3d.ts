// 3D model exporter for RocketModel (GLB, binary STL, OBJ).
//
// Axis & unit conventions:
// - Y-up: +Y points toward the rocket nose, origin at the nose tip (matches buildRocketMesh).
// - GLB: metres (glTF 2.0 standard), preserves materials/colors.
// - STL (binary) & OBJ: millimetres (1 m = 1000 mm, 3D-printing convention), Y-up.

import * as THREE from 'three';
import { buildRocketMesh } from '../render/rocketMesh';
import type { RocketModel } from '../types';

export type Model3DFormat = 'glb' | 'stl' | 'obj';

function isHelperObject(obj: THREE.Object3D): boolean {
  const anyObj = obj as unknown as Record<string, unknown>;
  return Boolean(
    anyObj.isLine ||
      anyObj.isLineSegments ||
      anyObj.isLineLoop ||
      anyObj.isPoints ||
      anyObj.isSprite ||
      obj.userData?.isHelper,
  );
}

/**
 * Build a clean Group with only visible Meshes, world transforms baked into
 * cloned geometries, and optional uniform scaling (e.g. 1000 for mm).
 */
function buildBakedExportGroup(rocket: RocketModel, scale: number): {
  group: THREE.Group;
  dispose: () => void;
} {
  const raw = buildRocketMesh(rocket, { cutaway: false });
  raw.updateMatrixWorld(true);

  const group = new THREE.Group();
  group.name = rocket.name || 'rocket';
  const geometries: THREE.BufferGeometry[] = [];

  raw.traverse((obj) => {
    if (!obj.visible || isHelperObject(obj)) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.geometry) return;

    const geom = mesh.geometry.clone();
    geom.applyMatrix4(mesh.matrixWorld);
    if (scale !== 1) {
      geom.scale(scale, scale, scale);
    }
    geometries.push(geom);

    const baked = new THREE.Mesh(geom, mesh.material);
    baked.name = mesh.name;
    group.add(baked);
  });

  return {
    group,
    dispose: () => {
      for (const g of geometries) g.dispose();
    },
  };
}

/**
 * Export a RocketModel to a 3D mesh format:
 * - `'glb'`: binary glTF 2.0 in metres, Y-up, with materials/colors.
 * - `'stl'`: binary STL in millimetres, Y-up.
 * - `'obj'`: Wavefront OBJ text in millimetres, Y-up.
 */
export async function exportRocketModel3D(
  rocket: RocketModel,
  format: Model3DFormat,
): Promise<Uint8Array | string> {
  const scale = format === 'glb' ? 1 : 1000;
  const { group, dispose } = buildBakedExportGroup(rocket, scale);

  try {
    if (format === 'glb') {
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      const exporter = new GLTFExporter();
      const buffer = (await exporter.parseAsync(group, { binary: true })) as ArrayBuffer;
      return new Uint8Array(buffer);
    }

    if (format === 'stl') {
      const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
      const exporter = new STLExporter();
      const view = exporter.parse(group, { binary: true });
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }

    const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
    const exporter = new OBJExporter();
    return exporter.parse(group);
  } finally {
    dispose();
  }
}
