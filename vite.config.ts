import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Pages whose boot module imports the real app only after sign-in, mapped to that app entry.
const APP_ENTRIES: Record<string, string> = {
  'index.html': 'src/app/main.ts',
  'landing.html': 'src/landing/main.ts',
};

// Content-Security-Policy for the built pages (meta tag, build only so the dev server and HMR
// are unaffected). Script hashes are filled in per page below.
// - connect-src: Supabase (auth, REST, realtime), ThrustCurve (motor data) and Open-Meteo
//   (launch-day weather, src/weather/launchWeather.ts).
// - worker-src blob: lets bundled module workers fall back to blob URLs.
// - 'wasm-unsafe-eval' allows WebAssembly only, not eval().
// frame-ancestors is ignored in a meta tag; clickjacking protection needs a real response header.
function cspFor(scriptHashes: string[]): string {
  const hashes = scriptHashes.map((h) => `'sha256-${h}'`).join(' ');
  return [
    `default-src 'self'`,
    `script-src 'self' ${hashes} 'wasm-unsafe-eval'`.replace(/ +/g, ' '),
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://www.thrustcurve.org https://thrustcurve.org https://api.open-meteo.com https://archive-api.open-meteo.com`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');
}

// Build-only HTML post-processing: (1) preload the app chunk while the sign-in gate runs,
// (2) add a CSP meta tag with hashes of the pages' inline scripts.
function htmlHardening(): Plugin {
  let base = '/';
  return {
    name: 'astra-html-hardening',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const page = (ctx.filename ?? '').replaceAll('\\', '/').split('/').pop() ?? '';
        let out = html;

        // (1) The boot module only import()s the app after the session check, so the browser
        // would otherwise fetch it serially after the ~800 KB gate chunk. modulepreload
        // downloads (and parses) the chunk and its static imports without executing them.
        const entry = APP_ENTRIES[page];
        const bundle = ctx.bundle;
        if (entry && bundle) {
          // The chunk holding the app entry module; its facadeModuleId can be null when Rollup
          // merges it with shared modules, so match on the modules it contains.
          const appChunk = Object.values(bundle).find(
            (c) => c.type === 'chunk' && c.isDynamicEntry && c.moduleIds.some((m) => m.replaceAll('\\', '/').endsWith(entry)),
          );
          if (appChunk && appChunk.type === 'chunk') {
            const seen = new Set<string>();
            const walk = (name: string): void => {
              if (seen.has(name)) return;
              seen.add(name);
              const c = bundle[name];
              if (c && c.type === 'chunk') c.imports.forEach(walk);
            };
            walk(appChunk.fileName);
            const tags = [...seen]
              .map((f) => `${base}${f}`)
              .filter((href) => !out.includes(`href="${href}"`))
              .map((href) => `    <link rel="modulepreload" crossorigin href="${href}" />`)
              .join('\n');
            if (tags) out = out.replace('</head>', `${tags}\n  </head>`);
          }
        }

        // (2) CSP, with a sha256 for every inline <script> in the final HTML.
        const hashes: string[] = [];
        const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
        for (let m = re.exec(out); m; m = re.exec(out)) {
          if (m[1].trim() === '') continue;
          hashes.push(createHash('sha256').update(m[1]).digest('base64'));
        }
        const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(hashes)}" />`;
        // First element in <head>, but after <meta charset> (which must stay in the first 1024 bytes).
        const charset = /<meta\s+charset=[^>]*>/i;
        out = charset.test(out)
          ? out.replace(charset, (c) => `${c}\n    ${meta}`)
          : out.replace(/<head[^>]*>/i, (h) => `${h}\n    ${meta}`);
        return out;
      },
    },
  };
}

// Two pages: the rocket builder (index.html) and the Moon landing view (landing.html).
export default defineConfig({
  plugins: [htmlHardening()],
  server: {
    port: 3000,
    strictPort: false,
  },
  preview: {
    port: 3000,
    strictPort: false,
  },
  build: {
    // three.js alone minifies to about 605 KB and the app chunk to about 600 KB; both are split
    // and long-cacheable already, so warn only when a chunk grows past that.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing.html'),
      },
      output: {
        // Long-cacheable vendor chunks, split out of the sign-in gate chunk.
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'vendor-three';
          if (id.includes('node_modules/@supabase/')) return 'vendor-supabase';
          return undefined;
        },
      },
    },
  },
});
