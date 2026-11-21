// Draws the app icon (flat rocket on a dark blue tile) as PNGs with no dependencies.
// Run from the project root: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

// Colour at normalised (x, y) in [0,1]; y grows downward.
function pixel(x, y) {
  const bg = [16, 28, 48], body = [242, 241, 236], nose = [226, 85, 47], fin = [43, 52, 64], flame = [255, 138, 43];
  const cx = x - 0.5;
  const halfW = 0.085;
  if (y > 0.2 && y < 0.36) {            // nose (ogive-ish)
    const t = (y - 0.2) / 0.16;
    if (Math.abs(cx) < halfW * Math.sqrt(t * (2 - t))) return nose;
  }
  if (y >= 0.36 && y < 0.7 && Math.abs(cx) < halfW) return body;
  if (y >= 0.56 && y < 0.72) {            // swept fins
    const t = (y - 0.56) / 0.16;
    if (Math.abs(cx) >= halfW && Math.abs(cx) < halfW + 0.12 * t) return fin;
  }
  if (y >= 0.7 && y < 0.86) {             // flame
    const t = (y - 0.7) / 0.16;
    if (Math.abs(cx) < 0.06 * (1 - t)) return flame;
  }
  return bg;
}

function png(size, scale = 1) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const ss = 3; // supersampling for smooth edges
  for (let j = 0; j < size; j++) {
    const row = j * (size * 3 + 1);
    raw[row] = 0;
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0];
      for (let a = 0; a < ss; a++) for (let b = 0; b < ss; b++) {
        const u = 0.5 + ((i + (a + 0.5) / ss) / size - 0.5) / scale;
        const v = 0.5 + ((j + (b + 0.5) / ss) / size - 0.5) / scale;
        const c = u < 0 || u > 1 || v < 0 || v > 1 ? [16, 28, 48] : pixel(u, v);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = row + 1 + i * 3;
      raw[o] = acc[0] / (ss * ss); raw[o + 1] = acc[1] / (ss * ss); raw[o + 2] = acc[2] / (ss * ss);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public', { recursive: true });
for (const size of [192, 512, 1024]) writeFileSync(`public/icon-${size}.png`, png(size));

// Android launcher icons (only if the Capacitor project exists).
const res = 'android/app/src/main/res';
if (existsSync(res)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, k] of Object.entries(dens)) {
    const dir = res + '/mipmap-' + name;
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/ic_launcher.png', png(48 * k));
    writeFileSync(dir + '/ic_launcher_round.png', png(48 * k));
    // Adaptive-icon foreground: art kept inside the central safe zone.
    writeFileSync(dir + '/ic_launcher_foreground.png', png(108 * k, 0.62));
  }
}
console.log('icons written');
