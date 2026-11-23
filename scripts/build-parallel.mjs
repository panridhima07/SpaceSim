// Production build: typecheck and bundle at the same time instead of one after the other.
// `tsc --noEmit` uses an incremental cache in node_modules/.cache, so repeat builds are faster.
// Exits non-zero if either step fails (the bundle may still have been written to dist/ then, but
// `npm run deploy` stops on the failed build exactly as before).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (p) => path.join(root, 'node_modules', p);

function run(name, args) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`\n── ${name} (${secs} s, exit ${code}) ──\n${out}`);
      resolve(code ?? 1);
    });
  });
}

const [tscCode, viteCode] = await Promise.all([
  run('typecheck', [
    bin('typescript/bin/tsc'),
    '--noEmit',
    '-p',
    '.',
    '--incremental',
    '--tsBuildInfoFile',
    'node_modules/.cache/tsc-app.tsbuildinfo',
  ]),
  run('vite build', [bin('vite/bin/vite.js'), 'build', ...process.argv.slice(2)]),
]);

process.exit(tscCode || viteCode);
