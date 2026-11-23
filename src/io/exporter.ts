// Unified rocket design exporter supporting OpenRocket (.ork), JSON, GLB, STL, and OBJ.
// 3D exporters are loaded lazily via dynamic import('./model3d') to keep initial bundle small.

import { toRocketModel, type Design } from '../builder/design';
import { exportOrkZip } from '../builder/orkExport';
import { exportDesignJson } from '../builder/storage';

export type ExportFormat = 'ork' | 'json' | 'glb' | 'stl' | 'obj';

export interface ExportFormatInfo {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  description: string;
}

export const EXPORT_FORMATS: ExportFormatInfo[] = [
  {
    id: 'ork',
    label: 'OpenRocket (.ork)',
    ext: 'ork',
    mime: 'application/zip',
    description: 'Open in OpenRocket or re-import here',
  },
  {
    id: 'json',
    label: 'Design JSON (.json)',
    ext: 'json',
    mime: 'application/json',
    description: 'Save full editable design data',
  },
  {
    id: 'glb',
    label: '3D Model (.glb)',
    ext: 'glb',
    mime: 'model/gltf-binary',
    description: 'View in 3D viewers, Blender, or web apps',
  },
  {
    id: 'stl',
    label: '3D Print (.stl)',
    ext: 'stl',
    mime: 'model/stl',
    description: 'Binary STL mesh in millimetres for 3D printing',
  },
  {
    id: 'obj',
    label: 'Wavefront (.obj)',
    ext: 'obj',
    mime: 'model/obj',
    description: 'Text 3D mesh in millimetres for CAD tools',
  },
];

export function safeFilename(name: string): string {
  return (name || 'rocket').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'rocket';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function exportDesign(
  design: Design,
  format: ExportFormat,
): Promise<{ blob: Blob; filename: string }> {
  const info = EXPORT_FORMATS.find((f) => f.id === format);
  if (!info) {
    throw new Error(`Unsupported export format: ${String(format)}`);
  }
  const filename = `${safeFilename(design.name)}.${info.ext}`;

  if (format === 'json') {
    return {
      blob: new Blob([exportDesignJson(design)], { type: info.mime }),
      filename,
    };
  }

  if (format === 'ork') {
    const bytes = await exportOrkZip(design);
    return {
      blob: new Blob([toArrayBuffer(bytes)], { type: info.mime }),
      filename,
    };
  }

  // Lazy-load 3D exporters so Three.js exporter code is not pulled into initial load.
  const { exportRocketModel3D } = await import('./model3d');
  const rocket = toRocketModel(design);
  const data = await exportRocketModel3D(rocket, format);
  const part: BlobPart = typeof data === 'string' ? data : toArrayBuffer(data);
  return {
    blob: new Blob([part], { type: info.mime }),
    filename,
  };
}
