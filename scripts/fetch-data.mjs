// Fetches real data so we do not hand-write it:
//  1. Certified motor thrust curves from ThrustCurve.org  -> src/ork/motorData.json
//  2. OpenRocket example designs (GPL, so NOT committed)  -> fixtures/external/*.ork
// Run from the project root: node scripts/fetch-data.mjs
import { access, mkdir, writeFile } from 'node:fs/promises';

const TC = 'https://www.thrustcurve.org/api/v1';
const MOTORS = [
  ['Estes', 'A8'], ['Estes', 'B4'], ['Estes', 'B6'], ['Estes', 'C6'], ['Estes', 'C11'],
  ['Estes', 'D12'], ['Estes', 'E12'], ['Estes', 'E16'], ['Estes', 'F15'],
  ['AeroTech', 'E15'], ['AeroTech', 'F40'], ['AeroTech', 'F52'], ['AeroTech', 'G64'],
  ['AeroTech', 'G80'], ['AeroTech', 'H128'], ['AeroTech', 'H180'], ['AeroTech', 'I284'],
  ['AeroTech', 'J350'], ['AeroTech', 'K550'], ['Cesaroni', 'H125'], ['Cesaroni', 'I255'],
];

// Be polite to the public API: pause between every request.
const REQUEST_GAP_MS = 1500;
// On HTTP 429, retry with these backoff delays (ms).
const BACKOFF_MS = [3000, 6000, 12000, 24000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
const throttle = async () => {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
};

const post = async (path, body) => {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const r = await fetch(`${TC}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if ((r.status === 429 || r.status >= 500) && attempt < BACKOFF_MS.length) {
      console.warn(`${r.status} on ${path}, retry ${attempt + 1} in ${BACKOFF_MS[attempt] / 1000}s`);
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  }
};

const motors = [];
for (const [manufacturer, commonName] of MOTORS) {
  try {
    const s = await post('search.json', { manufacturer, commonName, maxResults: 1 });
    const m = s.results?.[0];
    if (!m) { console.warn('not found', manufacturer, commonName); continue; }
    const numeric = [m.diameter, m.length, m.totalWeightG, m.propWeightG];
    if (!numeric.every(Number.isFinite)) { console.warn('missing physical data', commonName); continue; }
    const d = await post('download.json', { motorIds: [m.motorId], data: 'samples', maxResults: 1 });
    const samples = d.results?.[0]?.samples;
    if (!samples?.length) { console.warn('no curve', commonName); continue; }
    const curve = samples.map((p) => [p.time, p.thrust]);
    if (curve[0][0] > 0) curve.unshift([0, 0]);
    if (curve[curve.length - 1][1] !== 0) curve.push([curve[curve.length - 1][0] + 0.001, 0]);
    let impulse = 0;
    for (let i = 1; i < curve.length; i++) {
      impulse += 0.5 * (curve[i][1] + curve[i - 1][1]) * (curve[i][0] - curve[i - 1][0]);
    }
    motors.push({
      manufacturer: m.manufacturerAbbrev, designation: m.commonName,
      diameter: m.diameter / 1000, length: m.length / 1000,
      totalMass: m.totalWeightG / 1000, propellantMass: m.propWeightG / 1000,
      curve, burnTime: curve[curve.length - 1][0], totalImpulse: impulse, approximate: false,
    });
    console.log('motor', manufacturer, commonName, impulse.toFixed(1), 'N s');
  } catch (e) { console.warn('failed', commonName, e.message); }
}
const minMotors = Math.ceil(MOTORS.length * 0.8);
if (motors.length < minMotors) {
  console.error(`fetched ${motors.length} of ${MOTORS.length} requested motors (need at least ${minMotors}); motorData.json was left unchanged`);
  process.exitCode = 1;
} else {
  await writeFile('src/ork/motorData.json', JSON.stringify(motors));
  console.log(`wrote ${motors.length} of ${MOTORS.length} motors to src/ork/motorData.json`);
}

const OR = 'https://raw.githubusercontent.com/openrocket/openrocket/unstable/core/src/main/resources/datafiles/examples/';
const DESIGNS = ['A simple model rocket.ork', 'Dual parachute deployment.ork', 'Three stage low power rocket.ork', 'Two stage high power rocket.ork'];
await mkdir('fixtures/external', { recursive: true });
for (const name of DESIGNS) {
  const path = `fixtures/external/${name.replace(/ /g, '_')}`;
  if (await access(path).then(() => true, () => false)) {
    console.log('design exists, skipping', path);
    continue;
  }
  try {
    const r = await fetch(OR + encodeURIComponent(name), { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) { console.warn('design failed', name, r.status); process.exitCode = 1; continue; }
    // The source URL uses a moving branch, so validate the bytes before saving.
    const buf = Buffer.from(await r.arrayBuffer());
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    const isXml = buf.subarray(0, 5).toString('latin1') === '<?xml';
    if (buf.length <= 1000 || !(isZip || isXml)) {
      console.warn(name, 'not an .ork file, skipped'); process.exitCode = 1; continue;
    }
    await writeFile(path, buf);
    console.log('design', name);
  } catch (e) {
    console.warn('design failed', name, e.message); process.exitCode = 1;
  }
}
