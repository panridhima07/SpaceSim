// Packages the built site and the simulation function for `vercel deploy --prebuilt`.
// Run after `npm run build`. Output goes to .vercel/output (Vercel's Build Output format).
//
// The function is bundled here, with esbuild, because the app's sources use extensionless
// imports and a JSON import that Node's own module loader refuses.

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel', 'output');
const dist = join(root, 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'static'), { recursive: true });
cpSync(dist, join(out, 'static'), { recursive: true });

// Node-style (req, res) entry around the function's Web-standard fetch handler.
const entry = `
import handler from './api/simulate.ts';
export default async function (req, res) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = Buffer.concat(chunks);
    const response = await handler.fetch(new Request('https://' + (req.headers.host || 'localhost') + req.url, init));
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":false,"error":"Server error"}');
  }
}
`;

const funcDir = join(out, 'functions', 'api', 'simulate.func');
mkdirSync(funcDir, { recursive: true });
await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'vercel-entry.mjs', loader: 'js' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(funcDir, 'index.mjs'),
  logLevel: 'warning',
});
writeFileSync(
  join(funcDir, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);

writeFileSync(
  join(out, 'config.json'),
  JSON.stringify({
    version: 3,
    routes: [
      { src: '/sw.js', headers: { 'Cache-Control': 'no-cache' }, continue: true },
      { handle: 'filesystem' },
    ],
  }),
);

console.log('Wrote .vercel/output (static site + /api/simulate).');
