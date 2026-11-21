// Moon landing view: flies src/lunar/lander.ts from a 100 km lunar orbit to touchdown near the
// Chandrayaan-3 site and draws it. Separate page (landing.html) from the rocket builder.
//
// Scene frame: the landing site's tangent frame, +X east, +Y up, +Z south, metres, origin at the
// site on the reference sphere. Each frame the whole world is rotated so the lander's local
// vertical is +Y and shifted so the lander sits at the scene origin (floating origin), which keeps
// the picture upright all the way round the orbit and avoids float jitter.
//
// Not modelled here: the Sun direction is a fixed low Sun, not the real one for the date.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { julianDate } from '../world/ephemeris';
import { LANDER_SPECS, MU_M, R_MOON, cross, dot, unit, type V3 } from '../lunar/core';
import { LD, LanderSim, qrot } from '../lunar/lander';
import { createMoonEphemeris } from '../lunar/moonEphemeris';
import { llToMF, type HazardMap, type Terrain } from '../lunar/terrain';
import { attachTilt } from '../app/tilt';

const DEG = Math.PI / 180;
const SITE_LAT = -69.37, SITE_LON = 32.35; // Chandrayaan-3, Shiv Shakti point
const EPOCH = julianDate(new Date('2023-08-23T00:00:00Z'));
const ORBIT_ALT = 100e3;
const SPHERE_SINK = 150; // the globe sits this far under the terrain patches
const WARPS = [1, 2, 5, 10];

const $ = (id: string) => document.getElementById(id)!;
const view = $('view'), hud = $('hud'), logEl = $('log'), dock = $('dock'), resultEl = $('result'), busy = $('busy');
attachTilt([$('brand'), hud, logEl, dock]);

// ---------------------------------------------------------------- renderer and static scene
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 2e7);
camera.position.set(34, 16, 34);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.minDistance = 14;
controls.maxDistance = 4e6;
controls.enableDamping = true;

/** Everything fixed to the Moon. Moved and turned every frame; see the header. */
const world = new THREE.Group();
scene.add(world);
scene.add(new THREE.AmbientLight(0x8fa4c8, 0.16));
const sun = new THREE.DirectionalLight(0xfff2dc, 3.0);
world.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.62, 0.24, 0.75).normalize(); // site frame: low in the south-east

{
  // Stars: fixed to the camera's surroundings, so they are not parented to the world.
  const n = 1800, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = 2 * Math.random() - 1, a = 2 * Math.PI * Math.random(), s = Math.sqrt(1 - z * z);
    pos.set([1e7 * s * Math.cos(a), 1e7 * z, 1e7 * s * Math.sin(a)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfd8ea, size: 1.4, sizeAttenuation: false }));
  stars.frustumCulled = false;
  scene.add(stars);
}

// ---------------------------------------------------------------- lander model (body +Y is the thrust axis)
function buildLander(): { group: THREE.Group; plume: THREE.Mesh } {
  const group = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.55, metalness: 0.35 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.3, 2.2, 8), gold);
  body.position.y = 0.4;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.1, 0.9, 8), grey);
  deck.position.y = 1.95;
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.95, 1.3, 20, 1, true), dark);
  bell.position.y = -1.3;
  (bell.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  group.add(body, deck, bell);
  for (let k = 0; k < 4; k++) {
    // Feet sit on a circle of radius LD.FOOT, LD.CGH below the centre of gravity, like the contact model.
    const a = (k * Math.PI) / 2, foot = new THREE.Vector3(Math.cos(a) * LD.FOOT, -LD.CGH, Math.sin(a) * LD.FOOT);
    const hip = new THREE.Vector3(Math.cos(a) * 2.0, 0.2, Math.sin(a) * 2.0);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, hip.distanceTo(foot), 6), grey);
    leg.position.copy(hip).add(foot).multiplyScalar(0.5);
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foot.clone().sub(hip).normalize());
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 12), grey);
    pad.position.copy(foot).setY(foot.y + 0.05);
    group.add(leg, pad);
  }
  const plumeGeo = new THREE.ConeGeometry(0.9, 1, 20, 1, true);
  plumeGeo.translate(0, -0.5, 0); // tip at the nozzle, opens downward when scaled
  plumeGeo.rotateX(Math.PI);
  plumeGeo.translate(0, -1, 0);
  const plume = new THREE.Mesh(
    plumeGeo,
    new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  plume.position.y = -1.9;
  plume.visible = false;
  group.add(plume);
  return { group, plume };
}
const lander = buildLander();
scene.add(lander.group);

// ---------------------------------------------------------------- terrain meshes
/** Site-plane point (x east, y north, height h) to scene coordinates on the curved Moon. */
function sitePoint(x: number, y: number, h: number, out: THREE.Vector3): THREE.Vector3 {
  const k = (R_MOON + h) / Math.sqrt(x * x + y * y + R_MOON * R_MOON);
  return out.set(x * k, R_MOON * k - R_MOON, -y * k);
}

/** Square height-field patch of half-width `half`, skipping cells inside `hole` (a finer patch covers those). */
function buildPatch(terrain: Terrain, map: HazardMap, half: number, n: number, hole: number, rocks: boolean, skirt: boolean): THREE.Mesh {
  const pos = new Float32Array((n + 1) * (n + 1) * 3), col = new Float32Array((n + 1) * (n + 1) * 3);
  const p = new THREE.Vector3();
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -half + (2 * half * i) / n, y = -half + (2 * half * j) / n;
      let h = rocks ? terrain.ground(x, y) : terrain.height(x, y);
      if (skirt) {
        const e = Math.max(Math.abs(x), Math.abs(y)) / half;
        h -= SPHERE_SINK * 1.5 * Math.min(1, Math.max(0, (e - 0.93) / 0.07)); // tuck the edge under the globe
      }
      const o = (j * (n + 1) + i) * 3;
      sitePoint(x, y, h, p).toArray(pos, o);
      // Regolith grey with a little variation; landing hazards are tinted near the site.
      let r = 0.52 + 0.06 * Math.sin(x * 0.013) * Math.cos(y * 0.011), g = r, b = r * 0.98;
      const k = map.idx(x, y);
      if (k >= 0) {
        const hz = map.hzFoot[k];
        if (hz === 2) { r *= 1.14; g *= 0.88; b *= 0.85; } // hazard ground reads slightly red
      }
      col[o] = r; col[o + 1] = g; col[o + 2] = b;
    }
  }
  const index: number[] = [];
  const cell = (2 * half) / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * cell, y0 = -half + j * cell;
      if (hole > 0 && x0 >= -hole && x0 + cell <= hole && y0 >= -hole && y0 + cell <= hole) continue;
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  mesh.frustumCulled = false;
  return mesh;
}

let terrainGroup: THREE.Group | null = null;
const targetRing = new THREE.Mesh(
  new THREE.RingGeometry(7, 8.2, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x66ffa6, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
);
world.add(targetRing);

function buildWorld(L: LanderSim): void {
  if (terrainGroup) {
    world.remove(terrainGroup);
    terrainGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
  }
  const g = new THREE.Group();
  const t = L.terrain!, m = L.map!, S = L.site!;
  g.add(buildPatch(t, m, 240, 200, 0, true, false));
  g.add(buildPatch(t, m, 1600, 200, 240, false, false));
  g.add(buildPatch(t, m, t.half, 192, 1600, false, true));

  // The rest of the Moon: a textured globe whose axes are the Moon-fixed frame (x lon 0, y north, z 90 W).
  const globeMat = new THREE.MeshStandardMaterial({ color: 0x8d8d8d, roughness: 1, metalness: 0 });
  new THREE.TextureLoader().load('./assets/space/moonmap1k.jpg', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    globeMat.map = tex;
    globeMat.color.set(0xb4b4b4);
    globeMat.needsUpdate = true;
  }, undefined, () => {});
  const globe = new THREE.Mesh(new THREE.SphereGeometry(R_MOON - SPHERE_SINK, 256, 128), globeMat);
  // Columns are the Moon-fixed axes expressed in the site frame (east, up, south).
  globe.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(
    S.E[0], S.E[1], S.E[2], 0,
    S.U[0], S.U[1], S.U[2], 0,
    -S.N[0], -S.N[1], -S.N[2], 0,
    0, 0, 0, 1,
  ));
  globe.position.set(0, -R_MOON, 0);
  globe.frustumCulled = false;
  g.add(globe);
  world.add(g);
  terrainGroup = g;
}

// ---------------------------------------------------------------- simulation
const eph = createMoonEphemeris(EPOCH);
let sim: LanderSim;
let warp = 1;
let autoWarp = false;
let shownEvents = 0;
let resultShown = false;

/** Polar orbit whose deorbit burn, half an orbit later, brings the lander down near the chosen site. */
function startState() {
  const t0 = 0;
  const F = eph.moonFrame(t0);
  const mf = llToMF(SITE_LAT * DEG, SITE_LON * DEG);
  const s: V3 = [0, 1, 2].map((i) => mf[0] * F.x[i] + mf[1] * F.y[i] + mf[2] * F.z[i]);
  const n = unit(cross(s, F.y)); // orbit normal: plane through the site and the lunar pole
  const back = -(Math.PI + LanderSim.brakeArc(LANDER_SPECS.lander, ORBIT_ALT));
  const ns = cross(n, s);
  const rh: V3 = [0, 1, 2].map((i) => s[i] * Math.cos(back) + ns[i] * Math.sin(back));
  const vh = cross(n, rh), R = R_MOON + ORBIT_ALT, vc = Math.sqrt(MU_M / R);
  const rm = eph.moonAt(t0), vm = eph.moonVelAt(t0);
  return { t: t0, r: rm.map((v, i) => v + rh[i] * R), v: vm.map((v, i) => v + vh[i] * vc), a: vh };
}

function restart(): void {
  sim = new LanderSim(eph, startState(), LANDER_SPECS.lander);
  // Separation and the deorbit burn are flown before the view opens: the landing site and its
  // terrain only exist once the descent orbit is known.
  let guard = 0;
  while (sim.phase !== 'COAST' && sim.phase !== 'CRASHED' && guard++ < 20000) sim.advance(0.5);
  buildWorld(sim);
  warp = 1; autoWarp = false; shownEvents = 0; resultShown = false;
  logEl.textContent = '';
  resultEl.style.display = 'none';
  camera.position.set(34, 16, 34);
  refreshDock();
}

// ---------------------------------------------------------------- per-frame placement
const vUp = new THREE.Vector3(), vPos = new THREE.Vector3(), qView = new THREE.Quaternion(), qBody = new THREE.Quaternion();
const mBody = new THREE.Matrix4(), Y = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();

/** Inertial vector (Moon-centred) to site-frame components (east, up, south). */
function toSite(v: number[], out: THREE.Vector3): THREE.Vector3 {
  const m = sim.toMF(v), S = sim.site!;
  return out.set(dot(m, S.E), dot(m, S.U), -dot(m, S.N));
}

function place(): void {
  toSite(sim.r, vPos); // from the Moon's centre
  vUp.copy(vPos).normalize();
  vPos.y -= R_MOON; // from the site origin
  qView.setFromUnitVectors(vUp, Y);
  world.quaternion.copy(qView);
  world.position.copy(vPos).applyQuaternion(qView).negate();

  const bx = toSite(qrot(sim.q, [1, 0, 0]), new THREE.Vector3());
  const by = toSite(qrot(sim.q, [0, 1, 0]), new THREE.Vector3());
  const bz = toSite(qrot(sim.q, [0, 0, 1]), new THREE.Vector3());
  qBody.setFromRotationMatrix(mBody.makeBasis(bx, by, bz));
  lander.group.quaternion.copy(qView).multiply(qBody);

  lander.plume.visible = sim.engine && sim.thr > 0;
  if (lander.plume.visible) {
    const len = 3 + 9 * sim.thr * (0.9 + 0.2 * Math.random());
    lander.plume.scale.set(1, len, 1);
  }
  sun.position.copy(vPos).addScaledVector(SUN_DIR, 1000);
  sun.target.position.copy(vPos);

  const [tx, ty] = sim.tgt;
  sitePoint(tx, ty, sim.terrain!.height(tx, ty) + 0.6, targetRing.position);
  targetRing.visible = !sim.landed;
}

// ---------------------------------------------------------------- HUD
const fmt = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const dist = (m: number) => (Math.abs(m) >= 10_000 ? `${fmt(m / 1000, 1)} km` : `${fmt(m)} m`);
const PHASE_NAME: Record<string, string> = {
  SEP: 'Separation', DOI: 'Deorbit burn', COAST: 'Coast to perilune', BRAKE: 'Braking', APPROACH: 'Approach',
  TERMINAL: 'Terminal descent', LANDED: 'Landed', CRASHED: 'Crashed',
};
const HAZARD = ['Safe', 'Caution', 'Hazard'];

function row(label: string, value: string): string {
  return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function updateHud(): void {
  const t = sim.telemetry();
  const rows = [
    row('Altitude', dist(t.agl ?? t.alt) + (t.agl === null ? '' : ' AGL')),
    row('Descent rate', `${fmt(-t.vv, 1)} m/s`),
    row('Ground speed', `${fmt(t.vh, 1)} m/s`),
    t.toPDI !== null ? row('Powered descent in', `${fmt(t.toPDI / 60, 1)} min`) : row('Range to target', t.range === null ? '—' : dist(t.range)),
    row('Tilt', `${fmt(Math.hypot(t.tiltF, t.tiltR), 1)}°`),
    row('Ground below', t.hazard === null ? '—' : HAZARD[t.hazard]),
    row('Delta-v left', `${fmt(t.dv)} m/s`),
  ].join('');
  hud.innerHTML =
    `<div class="phase">${PHASE_NAME[t.phase] ?? t.phase}</div>` +
    `<div class="site">${t.site ?? ''}</div><table>${rows}</table>` +
    `<table>${row('Propellant', `${fmt(t.propPct * 100)} %`)}</table><div class="bar"><i style="width:${t.propPct * 100}%"></i></div>` +
    `<table>${row('Throttle', `${fmt(t.thr * 100)} %`)}</table><div class="bar"><i style="width:${t.thr * 100}%"></i></div>` +
    `<table>${row('Control', t.mode === 'AUTO' ? 'Autopilot' : t.hold ? `Manual · hold ${t.hold.toLowerCase()}` : 'Manual')}${row('Time warp', `×${effectiveWarp()}`)}</table>`;

  for (; shownEvents < sim.events.length; shownEvents++) {
    const e = sim.events[shownEvents], line = document.createElement('div');
    line.className = e.level;
    line.textContent = e.text;
    logEl.prepend(line);
    while (logEl.childElementCount > 7) logEl.lastElementChild!.remove();
  }

  if (!resultShown && (sim.phase === 'LANDED' || sim.phase === 'CRASHED')) {
    resultShown = true;
    const g = sim.landing;
    const ok = sim.phase === 'LANDED';
    const detail = ok && g
      ? `${fmt(g.vv, 2)} m/s down, ${fmt(g.vh, 2)} m/s sideways, tilt ${fmt(g.tilt ?? 0, 1)}°, ${fmt(g.miss ?? 0, 1)} m from the target. ` +
        `Score ${g.score} · ${fmt(g.propLeft ?? 0)} kg of propellant left.`
      : (sim.reason ?? 'The lander was lost.');
    resultEl.innerHTML = `<h2>${ok ? (g?.rating ?? 'Landed') : 'Lander lost'}</h2><p>${detail}</p>`;
    const again = document.createElement('button');
    again.textContent = 'Fly again';
    again.onclick = () => boot();
    const look = document.createElement('button');
    look.textContent = 'Look around';
    look.style.marginLeft = '6px';
    look.onclick = () => { resultEl.style.display = 'none'; };
    resultEl.append(again, look);
    resultEl.style.display = 'block';
    refreshDock();
  }
}

// ---------------------------------------------------------------- controls
function effectiveWarp(): number {
  if (sim.phase === 'COAST') return autoWarp ? sim.maxWarp() : Math.min(warp, Math.max(1, sim.maxWarp()));
  // The lander integrates in fixed 0.05 s steps whatever the frame time, so warping the long
  // braking burn is safe. The last 130 m stay close to real time so they can be watched and flown.
  if (sim.phase === 'BRAKE' || sim.phase === 'APPROACH') return warp;
  if (sim.phase === 'TERMINAL') return Math.min(warp, 2);
  return 1;
}

function refreshDock(): void {
  dock.textContent = '';
  const over = sim.phase === 'LANDED' || sim.phase === 'CRASHED';
  const add = (label: string, on: boolean, fn: () => void, title = '', disabled = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    if (on) b.classList.add('on');
    b.onclick = () => { fn(); b.blur(); refreshDock(); };
    dock.appendChild(b);
    return b;
  };
  add('Skip to descent', autoWarp, () => { autoWarp = !autoWarp; }, 'Fast-forward the coast to powered descent', sim.phase !== 'COAST' || sim.mode !== 'AUTO');
  add('Autopilot', sim.mode === 'AUTO', () => sim.setMode('AUTO'), 'T', over);
  add('Manual', sim.mode === 'MANUAL', () => sim.setMode('MANUAL'), 'T', over);
  if (sim.mode === 'MANUAL' && !over) {
    add('Thrust −', false, () => sim.setThrottle(sim.level - 0.1), 'Q');
    add('Thrust +', false, () => sim.setThrottle(Math.max(sim.level, 0.2) + 0.1), 'E');
    add('Hold up', sim.hold === 'UP', () => sim.setHold(sim.hold === 'UP' ? null : 'UP'), 'F');
    add('Hold retro', sim.hold === 'RETRO', () => sim.setHold(sim.hold === 'RETRO' ? null : 'RETRO'), 'R');
  }
  for (const w of WARPS) add(`×${w}`, warp === w && !autoWarp, () => { warp = w; autoWarp = false; }, 'Time warp (limited near the ground)', over);
  add('Restart', false, () => boot());
  const help = document.createElement('div');
  help.id = 'help';
  help.style.flexBasis = '100%';
  help.style.textAlign = 'center';
  help.textContent = 'Drag to look, scroll to zoom. Manual: W/S pitch · A/D roll · E/Q throttle · Z full · X cut · F hold up · R hold retrograde · T autopilot';
  dock.appendChild(help);
}

const held = new Set<string>();
function applyKeys(): void {
  const k = (a: string, b: string) => (held.has(a) || held.has(b) ? 1 : 0);
  sim.setInput({
    pitch: k('w', 'arrowup') - k('s', 'arrowdown'),
    roll: k('d', 'arrowright') - k('a', 'arrowleft'),
    thr: k('e', 'shift') - k('q', 'control'),
  });
}
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (e.repeat || !sim) return;
  held.add(key);
  if (key === 't') sim.setMode(sim.mode === 'AUTO' ? 'MANUAL' : 'AUTO');
  else if (key === 'x') sim.cutEngine();
  else if (key === 'z') sim.setThrottle(1);
  else if (key === 'f') sim.setHold('UP');
  else if (key === 'r') sim.setHold('RETRO');
  applyKeys();
  refreshDock();
});
window.addEventListener('keyup', (e) => {
  held.delete(e.key.toLowerCase());
  if (sim) applyKeys();
});
window.addEventListener('blur', () => { held.clear(); if (sim) applyKeys(); });

// ---------------------------------------------------------------- loop
function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let lastPhase = '';
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!sim) return;
  sim.advance(dt * effectiveWarp());
  if (sim.phase !== lastPhase) {
    lastPhase = sim.phase;
    if (sim.phase !== 'COAST') autoWarp = false;
    refreshDock();
  }
  place();
  controls.update();
  // Keep the near plane tight when close so the lander does not clip, loose when far for depth precision.
  tmp.copy(camera.position);
  camera.near = Math.max(0.5, tmp.length() * 0.02);
  camera.updateProjectionMatrix();
  updateHud();
  renderer.render(scene, camera);
}

function boot(): void {
  busy.style.display = 'block';
  // Let the "computing" note paint before the terrain is generated (about a second of work).
  setTimeout(() => {
    restart();
    lastPhase = '';
    busy.style.display = 'none';
  }, 30);
}
boot();
requestAnimationFrame(frame);

// Handle for the browser console and automated checks: astraLanding.sim().advance(60).
(window as unknown as { astraLanding: unknown }).astraLanding = { sim: () => sim };
