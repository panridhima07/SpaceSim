// Hands a generated file to the user. In a browser this is an ordinary download.
// Inside the Android app an <a download> click does nothing, so the bytes go to the
// native FileSaver plugin (android/.../FileSaverPlugin.java), which opens the system
// "Save as" dialog.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface FileSaverPlugin {
  save(options: { name: string; mime: string; data: string }): Promise<{ saved: boolean; uri?: string }>;
}

const FileSaver = registerPlugin<FileSaverPlugin>('FileSaver');

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function downloadInBrowser(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mimeForFilename(filename: string): string {
  if (/\.json$/i.test(filename)) return 'application/json';
  if (/\.glb$/i.test(filename)) return 'model/gltf-binary';
  if (/\.stl$/i.test(filename)) return 'model/stl';
  if (/\.obj$/i.test(filename)) return 'model/obj';
  // Android appends an extension it derives from a known MIME type, so stay generic
  // to keep ".ork" and other custom extensions as typed.
  return 'application/octet-stream';
}

/** 'saved' = written through the Android dialog, 'cancelled' = dialog dismissed, 'downloaded' = browser download. */
export async function saveBlob(blob: Blob, filename: string): Promise<'saved' | 'cancelled' | 'downloaded'> {
  if (!Capacitor.isNativePlatform()) {
    downloadInBrowser(blob, filename);
    return 'downloaded';
  }
  const result = await FileSaver.save({
    name: filename,
    mime: mimeForFilename(filename),
    data: await blobToBase64(blob),
  });
  return result.saved ? 'saved' : 'cancelled';
}
