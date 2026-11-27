export interface BundleManifest { build: string; version: string; minNativeCode: number; sha256: string; file: string }
export function listBundleFiles(distDir: string): string[];
export function makeBundle(options: { distDir: string; minNativeCode: number }): Promise<{ manifest: BundleManifest; zipPath: string; manifestPath: string }>;
