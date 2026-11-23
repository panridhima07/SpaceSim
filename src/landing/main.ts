// Chandrayaan-3 from the end of the launch to the lunar surface, in two views on one page
// (landing.html), separate from the rocket builder.
//
// 1. Journey: a playback of src/lunar/cruise.ts, the trajectory integrated from the launcher's
//    cutoff to a few minutes before powered descent. Earth, Moon and path are to scale, in
//    kilometres, Earth-centred equatorial axes turned so north is +Y.
// 2. Descent: src/lunar/lander.ts flown live from the state the journey ends in, drawn in the
//    landing site's frame: +X east, +Y up, +Z south, metres. Each frame the whole world is
//    rotated so the lander's local vertical is +Y and shifted so the lander sits at the origin
//    (floating origin), which keeps the picture upright and avoids float jitter.
//
// The Sun is where it was on the date being shown. In the descent view it is lifted to at
// least 5 degrees above the horizon so the ground is never unlit.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { gmstFromJd, heliocentricPosition } from '../world/ephemeris';
import { R_MOON, dot, norm, sub, unit, type V3 } from '../lunar/core';
import { CH3, cruiseStateAt, eclToEq, orbitAbout, type CruiseBody, type CruiseRecord } from '../lunar/cruise';
import { runCruise } from '../lunar/cruiseClient';
import { LanderSim, qrot } from '../lunar/lander';
import { createMoonEphemeris } from '../lunar/moonEphemeris';
import { llToMF, type HazardMap, type Terrain } from '../lunar/terrain';
import { RE, moonPosition, moonVelocity } from '../mission/engine';
import { attachTilt } from '../app/tilt';

const DEG = Math.PI / 180;
const DAY = 86400;
const SPHERE_SINK = 150; // the globe sits this far under the terrain patches
const WARPS = [1, 2, 5, 10];
const CRUISE_WARPS: [number, string][] = [[600, '10 min/s'], [3600, '1 h/s'], [21600, '6 h/s'], [86400, '1 day/s']];
const BURN_WARP = 240; // playback slows to this while an engine is firing
const SOI = 66e6; // inside this range of the Moon the path is drawn around the Moon

const $ = (id: string) => document.getElementById(id)!;
const view = $('view'), hud = $('hud'), logEl = $('log'), dock = $('dock'), resultEl = $('result'), busy = $('busy'), chip = $('chip');
attachTilt([$('brand'), hud, logEl, dock]);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);

function starField(radius: number): THREE.Points {
  const n = 1800, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = 2 * Math.random() - 1, a = 2 * Math.PI * Math.random(), s = Math.sqrt(1 - z * z);
    pos.set([radius * s * Math.cos(a), radius * z, radius * s * Math.sin(a)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfd8ea, size: 1.4, sizeAttenuation: false }));
  stars.frustumCulled = false;
  return stars;
}

function loadTexture(file: string, onLoad: (t: THREE.Texture) => void): void {
  new THREE.TextureLoader().load(`./assets/space/${file}`, (t) => { t.colorSpace = THREE.SRGBColorSpace; onLoad(t); }, undefined, () => {});
}

const fmt = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const dist = (m: number) => (Math.abs(m) >= 10_000 ? `${fmt(m / 1000, Math.abs(m) >= 1e6 ? 0 : 1)} km` : `${fmt(m)} m`);

// The HUD is built once per view and then updated in place: each tick writes a cell only when
// its text, class or width has changed since the last write.
const lastText = new WeakMap<HTMLElement, string>();
const lastWidth = new WeakMap<HTMLElement, string>();
function setText(el: HTMLElement, v: string): void {
  if (lastText.get(el) !== v) { lastText.set(el, v); el.textContent = v; }
}
function setClass(el: HTMLElement, v: string): void {
  if (el.className !== v) el.className = v;
}
function setWidth(el: HTMLElement, v: string): void {
  if (lastWidth.get(el) !== v) { lastWidth.set(el, v); el.style.width = v; }
}
function hudEl<K extends keyof HTMLElementTagNameMap>(tag: K, parent: Node | null, cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}
interface HudRow { tr: HTMLTableRowElement; label: HTMLTableCellElement; value: HTMLTableCellElement }
function hudRow(table: HTMLTableElement, label: string): HudRow {
  const tr = hudEl('tr', table), l = hudEl('td', tr), value = hudEl('td', tr);
  setText(l, label);
  return { tr, label: l, value };
}
/** A table followed by a `.bar` whose fill is returned. */
function hudBar(nodes: Node[]): HTMLElement {
  const bar = hudEl('div', null, 'bar');
  nodes.push(bar);
  return hudEl('i', bar);
}
/** Which view's HUD is currently in #hud. */
let hudShown: 'cruise' | 'descent' | null = null;
function showHud(which: 'cruise' | 'descent', nodes: Node[]): void {
  if (hudShown === which) return;
  hudShown = which;
  hud.replaceChildren(...nodes);
}

function logLine(text: string, level: string): void {
  const line = document.createElement('div');
  line.className = level;
  line.textContent = text;
  logEl.prepend(line);
  while (logEl.childElementCount > 7) logEl.lastElementChild!.remove();
}

/** Unit vector from the Earth to the Sun, ecliptic axes. */
function sunDirEcl(jd: number): V3 {
  const e = heliocentricPosition('Earth', jd);
  return unit([-e[0], -e[1], -e[2]]);
}

let rec: CruiseRecord;
let mode: 'cruise' | 'descent' = 'cruise';

// ================================================================================================
// Journey view
// ================================================================================================
const KM = 1e-3;
/** Equatorial metres (Z north) to scene kilometres (Y north). */
const toScene = (p: ArrayLike<number>, out: THREE.Vector3, o = 0): THREE.Vector3 => out.set(p[o] * KM, p[o + 2] * KM, -p[o + 1] * KM);

const cScene = new THREE.Scene();
cScene.background = new THREE.Color(0x000000);
const cCamera = new THREE.PerspectiveCamera(45, 1, 50, 6e6);
const cControls = new OrbitControls(cCamera, renderer.domElement);
cControls.enablePan = false;
cControls.enableDamping = true;
cControls.minDistance = 2600;
cControls.maxDistance = 2.5e6;
cScene.add(starField(4e6), new THREE.AmbientLight(0x8fa4c8, 0.32));
const cSun = new THREE.DirectionalLight(0xfff6e6, 2.6);
cScene.add(cSun, cSun.target);

const earthMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 1, metalness: 0 });
loadTexture('earth_atmos_2048.jpg', (t) => { earthMat.map = t; earthMat.color.set(0xffffff); earthMat.needsUpdate = true; });
const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(RE * KM, 96, 48), earthMat);
cScene.add(earthMesh);

const moonGroup = new THREE.Group(); // at the Moon, axes not turning: the lunar part of the path lives here
cScene.add(moonGroup);
const moonMat = new THREE.MeshStandardMaterial({ color: 0x8d8d8d, roughness: 1, metalness: 0 });
loadTexture('moonmap1k.jpg', (t) => { moonMat.map = t; moonMat.color.set(0xd0d0d0); moonMat.needsUpdate = true; });
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(R_MOON * KM, 64, 32), moonMat);
moonGroup.add(moonMesh);
{
  // Landing site marker, fixed to the turning Moon.
  const m = llToMF(CH3.site.latDeg * DEG, CH3.site.lonDeg * DEG);
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([m[0], m[1], m[2]].map((v) => v * (R_MOON * KM + 12))), 3));
  moonMesh.add(new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: 0x66ffa6, size: 7, sizeAttenuation: false, depthTest: false })));
}

const craftGeo = new THREE.BufferGeometry();
craftGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
const craft = new THREE.Points(craftGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, depthTest: false }));
const craftGlow = new THREE.Points(craftGeo, new THREE.PointsMaterial({ color: 0xffa23a, size: 18, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.75 }));
craft.frustumCulled = craftGlow.frustumCulled = false;
craft.renderOrder = 3; craftGlow.renderOrder = 2;
cScene.add(craft, craftGlow);

interface PathLines { flown: THREE.Line; ahead: THREE.Line; burns: THREE.LineSegments; first: number; count: number }
let geoPath: PathLines | null = null, lunPath: PathLines | null = null;
let split = 0; // first sample drawn around the Moon
let cruiseT = 0, cruisePlaying = true, cruiseWarp = 21600, shownCruiseEvents = 0;
let focus: CruiseBody | 'craft' = 'earth', focusAuto = true, userZoomed = false;
cControls.addEventListener('start', () => { userZoomed = true; });

function makePath(pos: Float32Array, first: number, count: number, parent: THREE.Object3D): PathLines {
  const attr = new THREE.BufferAttribute(pos, 3);
  const mk = (color: number, opacity: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', attr);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
    l.frustumCulled = false;
    return l;
  };
  const ahead = mk(0x5a5a62, 0.45), flown = mk(0xf5a65b, 1);
  const seg: number[] = [];
  for (let i = 0; i + 1 < count; i++) if (rec.burning[first + i + 1]) seg.push(i, i + 1);
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', attr);
  bg.setIndex(seg);
  const burns = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0xffa23a, depthTest: false }));
  burns.frustumCulled = false;
  burns.renderOrder = 1;
  parent.add(ahead, flown, burns);
  return { flown, ahead, burns, first, count };
}

function buildCruiseScene(): void {
  const jdAt = (t: number) => rec.epochJD + t / DAY;
  split = rec.n - 1;
  for (let i = 0; i < rec.n; i++) {
    const m = moonPosition(jdAt(rec.t[i]));
    if (Math.hypot(rec.r[3 * i] - m[0], rec.r[3 * i + 1] - m[1], rec.r[3 * i + 2] - m[2]) < SOI) { split = i; break; }
  }
  const v = new THREE.Vector3();
  const geo = new Float32Array((split + 1) * 3);
  for (let i = 0; i <= split; i++) toScene(rec.r, v, 3 * i).toArray(geo, 3 * i);
  const lun = new Float32Array((rec.n - split) * 3);
  for (let i = split; i < rec.n; i++) {
    const m = moonPosition(jdAt(rec.t[i]));
    toScene([rec.r[3 * i] - m[0], rec.r[3 * i + 1] - m[1], rec.r[3 * i + 2] - m[2]], v).toArray(lun, 3 * (i - split));
  }
  geoPath = makePath(geo, 0, split + 1, cScene);
  lunPath = makePath(lun, split, rec.n - split, moonGroup);

  // The Moon's own path over the same weeks.
  const t0 = rec.t[0], t1 = rec.t[rec.n - 1], steps = Math.ceil((t1 - t0) / 7200);
  const mp = new Float32Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) toScene(moonPosition(jdAt(t0 + ((t1 - t0) * i) / steps)), v).toArray(mp, 3 * i);
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
  const moonTrack = new THREE.Line(mg, new THREE.LineBasicMaterial({ color: 0x8a8f99, transparent: true, opacity: 0.35 }));
  moonTrack.frustumCulled = false;
  cScene.add(moonTrack);
}

const eqAxisToScene = (p: V3, out: THREE.Vector3) => out.set(p[0], p[2], -p[1]);
const cTmp = new THREE.Vector3(), cPos = new THREE.Vector3(), cMoon = new THREE.Vector3(), cFocus = new THREE.Vector3();
const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3(), mBasis = new THREE.Matrix4();
let eph = createMoonEphemeris(0);

interface CruiseNow { body: CruiseBody; alt: number; speed: number; orbit: { peri: number; apo: number; normal: V3 }; mass: number; burning: boolean; moonRange: number }
let cruiseNow: CruiseNow | null = null;

/** `dt` is the frame time in seconds; it paces the automatic camera zoom. */
function placeCruise(dt: number): void {
  const jd = rec.epochJD + cruiseT / DAY;
  const st = cruiseStateAt(rec, cruiseT);
  const mp = moonPosition(jd), mv = moonVelocity(jd);
  toScene(st.r, cPos);
  toScene(mp, cMoon);
  moonGroup.position.copy(cMoon);
  const F = eph.moonFrame(cruiseT);
  mBasis.makeBasis(eqAxisToScene(eclToEq(F.x, rec.epochJD), bx), eqAxisToScene(eclToEq(F.y, rec.epochJD), by), eqAxisToScene(eclToEq(F.z, rec.epochJD), bz));
  moonMesh.quaternion.setFromRotationMatrix(mBasis);
  earthMesh.rotation.y = gmstFromJd(jd);
  (craftGeo.attributes.position as THREE.BufferAttribute).setXYZ(0, cPos.x, cPos.y, cPos.z).needsUpdate = true;
  craftGlow.visible = st.burning;
  eqAxisToScene(eclToEq(sunDirEcl(jd), rec.epochJD), cTmp);
  cSun.position.copy(cTmp).multiplyScalar(1e6);

  geoPath!.flown.geometry.setDrawRange(0, Math.min(st.index + 2, geoPath!.count));
  lunPath!.flown.geometry.setDrawRange(0, Math.max(0, Math.min(st.index + 2 - split, lunPath!.count)));

  const rMoon = sub(st.r, mp), moonRange = norm(rMoon);
  const body: CruiseBody = moonRange < SOI ? 'moon' : 'earth';
  const r = body === 'moon' ? rMoon : st.r, vRel = body === 'moon' ? sub(st.v, mv) : st.v;
  const orbit = orbitAbout(r, vRel, body);
  cruiseNow = { body, alt: norm(r) - (body === 'moon' ? R_MOON : RE), speed: norm(vRel), orbit, mass: st.mass, burning: st.burning, moonRange };

  // Camera: follow the body being orbited and, until the user takes over, keep the whole orbit in view.
  if (focusAuto && focus !== 'craft' && focus !== body) setFocus(body, true);
  if (focus === 'earth') cFocus.set(0, 0, 0); else if (focus === 'moon') cFocus.copy(cMoon); else cFocus.copy(cPos);
  cCamera.position.add(cTmp.copy(cFocus).sub(cControls.target));
  cControls.target.copy(cFocus);
  if (!userZoomed && focus !== 'craft') {
    const far = Number.isFinite(orbit.apo) ? orbit.apo : 4e8;
    const want = focus === 'moon' ? Math.max(9000, Math.min(60000, 2.7 * (far * KM + R_MOON * KM))) : Math.max(60000, Math.min(1.15e6, 2.7 * (Math.min(far, 4.2e8) * KM + RE * KM)));
    const off = cTmp.copy(cCamera.position).sub(cFocus), now = off.length();
    if (now > 1e-6) {
      // Exponential approach, the same feel at any frame rate (4% a frame at 60 fps).
      const k = 1 - Math.exp(-dt * CAM_EASE);
      cCamera.position.copy(cFocus).addScaledVector(off, (now + (want - now) * k) / now);
    } else {
      cCamera.position.copy(cFocus).addScaledVector(CAM_DIR, want); // sitting on the focus: step back out
    }
  }
}
const CAM_EASE = 2.45; // per second; 1 - exp(-2.45 / 60) ≈ 0.04
const CAM_DIR = new THREE.Vector3(0.25, 0.55, 0.8).normalize();

function setFocus(f: CruiseBody | 'craft', auto: boolean): void {
  focus = f; focusAuto = auto; userZoomed = false;
  cControls.minDistance = f === 'earth' ? 9000 : f === 'moon' ? 2600 : 300;
  const off = new THREE.Vector3(0.25, 0.55, 0.8);
  if (f === 'moon' && cruiseNow && cruiseNow.body === 'moon') {
    // Look along the orbit normal, tipped a little, so the polar orbit is seen open.
    eqAxisToScene(cruiseNow.orbit.normal, off).multiplyScalar(-1).add(new THREE.Vector3(0.2, 0.25, 0.1));
  }
  const d = f === 'earth' ? 120000 : f === 'moon' ? 40000 : 6000;
  const target = f === 'earth' ? new THREE.Vector3() : f === 'moon' ? cMoon.clone() : cPos.clone();
  cControls.target.copy(target);
  cCamera.position.copy(target).addScaledVector(off.normalize(), d);
}

function cruiseDate(t: number): string {
  return new Date((rec.epochJD + t / DAY - 2440587.5) * 86400000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function updateCruiseHud(): void {
  const n = cruiseNow;
  if (!n) return;
  const ev = rec.events;
  let last = -1;
  for (let i = 0; i < ev.length && ev[i].t <= cruiseT; i++) last = i;
  const next = ev[last + 1];
  const title = n.burning && next ? next.label : last >= ev.length - 1 ? 'Ready for descent' : 'Coasting';
  const orbitText = Number.isFinite(n.orbit.apo) ? `${fmt(n.orbit.peri / 1000)} × ${fmt(n.orbit.apo / 1000)} km` : 'Flyby path';
  const pmLeft = n.mass > CH3.landerMass + 1 ? CH3.pmProp - (CH3.stackMass - n.mass) : null;
  const h = cruiseHud ??= buildCruiseHud();
  showHud('cruise', h.nodes);
  setText(h.phase, title);
  setText(h.site, `Day ${fmt(cruiseT / DAY, 1)} · ${cruiseDate(cruiseT)}`);
  setText(h.orbiting.value, n.body === 'moon' ? 'Moon' : 'Earth');
  setText(h.alt.value, dist(n.alt));
  setText(h.speed.value, `${fmt(n.speed)} m/s`);
  setText(h.orbit.value, orbitText);
  setText(h.moonRange.value, dist(n.moonRange));
  setText(h.mass.value, `${fmt(n.mass)} kg`);
  setText(h.module.label, pmLeft !== null ? 'Module propellant' : 'Flying');
  setText(h.module.value, pmLeft !== null ? `${fmt(pmLeft)} kg` : 'Vikram alone');
  setText(h.engine.value, n.burning ? 'Firing' : 'Off');
  setClass(h.engine.value, n.burning ? 'am' : '');
  if (next) {
    setText(h.next.value, `${next.label} in ${fmt(Math.max(0, next.t - (next.burn ?? 0) - cruiseT) / 3600, 1)} h`);
    if (h.next.tr.parentNode !== h.table) h.table.insertBefore(h.next.tr, h.playback.tr);
  } else if (h.next.tr.parentNode) h.next.tr.remove();
  setText(h.playback.value, cruisePlaying ? (n.burning ? `×${BURN_WARP} (burn)` : CRUISE_WARPS.find((w) => w[0] === cruiseWarp)?.[1] ?? '') : 'Paused');

  // Rebuild the log when time jumps backward; otherwise append what has just happened.
  if (shownCruiseEvents > last + 1) { shownCruiseEvents = Math.max(0, last - 5); logEl.textContent = ''; }
  for (; shownCruiseEvents <= last; shownCruiseEvents++) {
    const e = ev[shownCruiseEvents];
    logLine(`${e.label.toUpperCase()} · ${e.detail}${e.real ? ` Real flight: ${e.real}.` : ''}`, e.dv ? 'am' : 'ok');
  }
  const scrub = scrubEl;
  if (scrub && document.activeElement !== scrub) {
    const v = String(Math.round((1000 * (cruiseT - rec.t[0])) / (rec.handoff.t - rec.t[0])));
    if (scrub.value !== v) scrub.value = v;
  }
}

interface CruiseHud {
  nodes: Node[]; table: HTMLTableElement; phase: HTMLElement; site: HTMLElement;
  orbiting: HudRow; alt: HudRow; speed: HudRow; orbit: HudRow; moonRange: HudRow; mass: HudRow;
  module: HudRow; engine: HudRow; next: HudRow; playback: HudRow;
}
let cruiseHud: CruiseHud | null = null;
function buildCruiseHud(): CruiseHud {
  const phase = hudEl('div', null, 'phase'), site = hudEl('div', null, 'site'), table = hudEl('table', null);
  const h: CruiseHud = {
    nodes: [phase, site, table], table, phase, site,
    orbiting: hudRow(table, 'Orbiting'),
    alt: hudRow(table, 'Altitude'),
    speed: hudRow(table, 'Speed'),
    orbit: hudRow(table, 'Orbit'),
    moonRange: hudRow(table, 'Moon range'),
    mass: hudRow(table, 'Mass'),
    module: hudRow(table, 'Module propellant'), // relabelled 'Flying' once the module is gone
    engine: hudRow(table, 'Engine'),
    next: hudRow(table, 'Next'), // detached while there is no next event
    playback: hudRow(table, 'Playback'),
  };
  h.next.tr.remove();
  return h;
}

function startCruise(): void {
  mode = 'cruise';
  chip.textContent = 'Journey to the Moon';
  cruiseT = rec.t[0]; cruisePlaying = true; shownCruiseEvents = 0; resultShown = false;
  logEl.textContent = '';
  resultEl.style.display = 'none';
  dControls.enabled = false; cControls.enabled = true;
  cruiseNow = null;
  setFocus('earth', true);
  placeCruise(0);
  refreshDock();
}

// ================================================================================================
// Descent view
// ================================================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 2e7);
const dControls = new OrbitControls(camera, renderer.domElement);
dControls.enablePan = false;
dControls.minDistance = 6;
dControls.maxDistance = 4e6;
dControls.enableDamping = true;
dControls.enabled = false;

/** Everything fixed to the Moon. Moved and turned every frame; see the header. */
const world = new THREE.Group();
scene.add(world, starField(1e7));
scene.add(new THREE.AmbientLight(0x8fa4c8, 0.16));
const sun = new THREE.DirectionalLight(0xfff2dc, 3.0);
world.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.62, 0.24, 0.75).normalize(); // site frame; set from the date in buildWorld

// ---------------------------------------------------------------- Vikram (body +Y is the thrust axis)
interface LanderModel { group: THREE.Group; plumes: THREE.Mesh[]; rover: THREE.Group; ramp: THREE.Mesh }
function buildVikram(cgh: number, foot: number): LanderModel {
  // The contact model has its feet on the body X and Z axes; the box is built with legs at its
  // corners and then turned 45 degrees so the drawn feet are the ones that touch the ground.
  const outer = new THREE.Group(), group = new THREE.Group();
  group.rotation.y = Math.PI / 4;
  outer.add(group);
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.5, metalness: 0.45 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7, side: THREE.DoubleSide });
  const cell = new THREE.MeshStandardMaterial({ color: 0x1b2a55, roughness: 0.35, metalness: 0.6 });
  // Box body about 2 m square, wrapped in gold foil, solar cells on three faces.
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.15, 2.0), gold);
  body.position.y = 0.2;
  group.add(body);
  for (const [x, z, ry] of [[0, 1.01, 0], [0, -1.01, Math.PI], [-1.01, 0, -Math.PI / 2]] as const) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.95), cell);
    p.position.set(x, 0.2, z);
    p.rotation.y = ry;
    group.add(p);
  }
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.12, 0.12, 20), grey);
  dish.position.set(-0.45, 0.86, -0.45);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 6), grey);
  mast.position.set(0.6, 1.05, 0.6);
  group.add(dish, mast);
  const plumes: THREE.Mesh[] = [];
  const plumeGeo = new THREE.ConeGeometry(0.34, 1, 16, 1, true);
  plumeGeo.translate(0, -0.5, 0); // tip at the nozzle
  plumeGeo.rotateX(Math.PI);
  plumeGeo.translate(0, -1, 0);
  const plumeMat = new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const [x, z] of [[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) {
    // Four 800 N engines at the corners of the base.
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.2, 0.34, 14, 1, true), dark);
    bell.position.set(x, -0.54, z);
    const plume = new THREE.Mesh(plumeGeo, plumeMat);
    plume.position.set(x, -0.72, z);
    plume.visible = false;
    group.add(bell, plume);
    plumes.push(plume);
  }
  for (let k = 0; k < 4; k++) {
    // Feet sit on a circle of radius `foot`, `cgh` below the centre of gravity, like the contact model.
    const a = (k * Math.PI) / 2 + Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
    const pad = new THREE.Vector3(c * foot, -cgh, s * foot), hip = new THREE.Vector3(c * 1.3, 0.1, s * 1.3), knee = new THREE.Vector3(c * 1.2, -0.35, s * 1.2);
    for (const from of [hip, knee]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, from.distanceTo(pad), 6), grey);
      leg.position.copy(from).add(pad).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pad.clone().sub(from).normalize());
      group.add(leg);
    }
    const sole = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 12), grey);
    sole.position.copy(pad).setY(pad.y + 0.03);
    group.add(sole);
  }
  // Pragyan and its ramp, on the +X face; both stay stowed until touchdown.
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.04, 0.9), grey);
  ramp.geometry.translate(0.95, 0, 0);
  ramp.position.set(1.0, -0.36, 0);
  ramp.rotation.z = Math.PI / 2;
  const rover = new THREE.Group();
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.6), gold);
  chassis.position.y = 0.24;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.6), cell);
  panel.position.set(0, 0.5, -0.32);
  panel.rotation.x = -0.25;
  rover.add(chassis, panel);
  for (const wx of [-0.36, 0, 0.36]) for (const wz of [-0.36, 0.36]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 12), dark);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.13, wz);
    rover.add(w);
  }
  rover.visible = false;
  group.add(ramp, rover);
  return { group: outer, plumes, rover, ramp };
}
let lander: LanderModel | null = null;

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
      if (k >= 0 && map.hzFoot[k] === 2) { r *= 1.14; g *= 0.88; b *= 0.85; } // hazard ground reads slightly red
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
  new THREE.RingGeometry(4, 4.7, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x66ffa6, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
);
world.add(targetRing);
let sunNote = '';

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
  loadTexture('moonmap1k.jpg', (tex) => { globeMat.map = tex; globeMat.color.set(0xb4b4b4); globeMat.needsUpdate = true; });
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

  // Sun direction at the site when powered descent starts.
  const tSun = L.plan?.tPDI ?? L.t;
  const sm = L.toMF(sunDirEcl(rec.epochJD + tSun / DAY), eph.moonFrame(tSun));
  let east = dot(sm, S.E), up = dot(sm, S.U), north = dot(sm, S.N);
  const elev = Math.asin(Math.max(-1, Math.min(1, up))) / DEG, floor = 5;
  sunNote = `${fmt(elev, 1)}°`;
  if (elev < floor) {
    const hz = Math.hypot(east, north) || 1, c = Math.cos(floor * DEG) / hz;
    east *= c; north *= c; up = Math.sin(floor * DEG);
    sunNote += ` (drawn at ${floor}°)`;
  }
  SUN_DIR.set(east, up, -north).normalize();
}

// ---------------------------------------------------------------- simulation
let sim: LanderSim;
let warp = 5;
let autoWarp = true;
let shownEvents = 0;
let resultShown = false;
let roverClock = 0;

function startDescent(): void {
  const h = rec.handoff, rm = eph.moonAt(h.t), vm = eph.moonVelAt(h.t);
  sim = new LanderSim(eph, { t: h.t, r: h.r.map((x, i) => x + rm[i]), v: h.v.map((x, i) => x + vm[i]), a: h.v.map((x) => -x) }, h.spec);
  if (!sim.beginDescentTo(CH3.site.latDeg * DEG, CH3.site.lonDeg * DEG, CH3.site.name)) throw new Error('The orbit does not pass the landing site');
  buildWorld(sim);
  if (lander) scene.remove(lander.group);
  lander = buildVikram(sim.G.cgh, sim.G.foot);
  scene.add(lander.group);
  mode = 'descent';
  chip.textContent = 'Powered descent';
  warp = 5; autoWarp = true; shownEvents = 0; resultShown = false; roverClock = 0;
  logEl.textContent = '';
  resultEl.style.display = 'none';
  cControls.enabled = false; dControls.enabled = true;
  dControls.target.set(0, 0, 0);
  camera.position.set(13, 5, 13);
  lastPhase = '';
  refreshDock();
}

// ---------------------------------------------------------------- per-frame placement
const vUp = new THREE.Vector3(), vPos = new THREE.Vector3(), qView = new THREE.Quaternion(), qBody = new THREE.Quaternion();
const mBody = new THREE.Matrix4(), Y = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();
const dAx = new THREE.Vector3(), dAy = new THREE.Vector3(), dAz = new THREE.Vector3(); // lander body axes, site frame

/** Inertial vector (Moon-centred) to site-frame components (east, up, south). */
function toSite(v: number[], out: THREE.Vector3): THREE.Vector3 {
  const m = sim.toMF(v), S = sim.site!;
  return out.set(dot(m, S.E), dot(m, S.U), -dot(m, S.N));
}

function place(dt: number): void {
  const L = lander!;
  toSite(sim.r, vPos); // from the Moon's centre
  vUp.copy(vPos).normalize();
  vPos.y -= R_MOON; // from the site origin
  qView.setFromUnitVectors(vUp, Y);
  world.quaternion.copy(qView);
  world.position.copy(vPos).applyQuaternion(qView).negate();

  toSite(qrot(sim.q, [1, 0, 0]), dAx);
  toSite(qrot(sim.q, [0, 1, 0]), dAy);
  toSite(qrot(sim.q, [0, 0, 1]), dAz);
  qBody.setFromRotationMatrix(mBody.makeBasis(dAx, dAy, dAz));
  L.group.quaternion.copy(qView).multiply(qBody);

  const firing = sim.engine && sim.thr > 0;
  for (const p of L.plumes) {
    p.visible = firing;
    if (firing) p.scale.set(1, 1.2 + 4.5 * sim.thr * (0.9 + 0.2 * Math.random()), 1);
  }
  sun.position.copy(vPos).addScaledVector(SUN_DIR, 1000);
  sun.target.position.copy(vPos);

  const [tx, ty] = sim.tgt;
  sitePoint(tx, ty, sim.terrain!.height(tx, ty) + 0.6, targetRing.position);
  targetRing.visible = !sim.landed;

  // After touchdown the ramp folds down and Pragyan drives off. Shown, not simulated.
  if (sim.landed && sim.phase === 'LANDED') {
    roverClock += dt;
    const open = Math.min(1, Math.max(0, (roverClock - 2) / 3));
    const rampDown = Math.atan2(sim.G.cgh - 0.36, 1.7);
    L.ramp.rotation.z = Math.PI / 2 - open * (Math.PI / 2 + rampDown);
    const go = Math.min(1, Math.max(0, (roverClock - 6) / 14));
    L.rover.visible = roverClock > 5.5;
    const x = 0.6 + 6.4 * go * go * (3 - 2 * go);
    const onRamp = Math.min(1, Math.max(0, (x - 1.0) / 1.7));
    L.rover.position.set(x, -0.36 - onRamp * (sim.G.cgh - 0.36), 0);
    L.rover.rotation.z = x > 1.0 && x < 2.7 ? -rampDown : 0;
    if (roverClock > 20.5 && !roverTold) { roverTold = true; logLine('PRAGYAN IS ON THE SURFACE', 'ok'); }
  } else {
    L.ramp.rotation.z = Math.PI / 2;
    L.rover.visible = false;
    roverTold = false;
  }
}
let roverTold = false;

// ---------------------------------------------------------------- HUD
const PHASE_NAME: Record<string, string> = {
  SEP: 'Separation', DOI: 'Deorbit burn', COAST: 'Coast to ignition', BRAKE: 'Rough braking', APPROACH: 'Fine braking',
  TERMINAL: 'Terminal descent', LANDED: 'Landed', CRASHED: 'Crashed',
};
const HAZARD = ['Safe', 'Caution', 'Hazard'];
const HAZARD_CLS = ['ok', 'am', 'bad'];

function updateHud(): void {
  const t = sim.telemetry();
  const h = descentHud ??= buildDescentHud();
  showHud('descent', h.nodes);
  setText(h.phase, PHASE_NAME[t.phase] ?? t.phase);
  setText(h.site, t.site ?? '');
  setText(h.alt.value, dist(t.agl ?? t.alt) + (t.agl === null ? '' : ' AGL'));
  setText(h.rate.value, `${fmt(-t.vv, 1)} m/s`);
  setText(h.ground.value, `${fmt(t.vh, 1)} m/s`);
  setText(h.aim.label, t.toPDI !== null ? 'Ignition in' : 'Range to target');
  setText(h.aim.value, t.toPDI !== null ? `${fmt(t.toPDI / 60, 1)} min` : t.range === null ? '—' : dist(t.range));
  setText(h.tilt.value, `${fmt(Math.hypot(t.tiltF, t.tiltR), 1)}°`);
  setText(h.twr.value, fmt(t.twr, 2));
  setText(h.hazard.value, t.hazard === null ? '—' : HAZARD[t.hazard]);
  setClass(h.hazard.value, t.hazard === null ? '' : HAZARD_CLS[t.hazard]);
  setText(h.mass.value, `${fmt(t.mass)} kg`);
  setText(h.dv.value, `${fmt(t.dv)} m/s`);
  setText(h.sun.value, sunNote);
  setText(h.prop.value, `${fmt(t.prop)} kg`);
  setWidth(h.propBar, `${t.propPct * 100}%`);
  setText(h.thr.value, `${fmt(t.thr * 100)} %`);
  setWidth(h.thrBar, `${t.thr * 100}%`);
  setText(h.control.value, t.mode === 'AUTO' ? 'Autopilot' : t.hold ? `Manual · hold ${t.hold.toLowerCase()}` : 'Manual');
  setText(h.warp.value, `×${effectiveWarp()}`);

  for (; shownEvents < sim.events.length; shownEvents++) logLine(sim.events[shownEvents].text, sim.events[shownEvents].level);

  if (!resultShown && (sim.phase === 'LANDED' || sim.phase === 'CRASHED')) {
    resultShown = true;
    const g = sim.landing;
    const ok = sim.phase === 'LANDED';
    const detail = ok && g
      ? `Touchdown ${cruiseDate(sim.t)} at ${fmt(g.vv, 2)} m/s down and ${fmt(g.vh, 2)} m/s sideways, tilted ${fmt(g.tilt ?? 0, 1)}°, ` +
        `${fmt(g.miss ?? 0, 1)} m from the aim point at ${CH3.site.name}. ${fmt(g.propLeft ?? 0)} kg of propellant left after ${fmt(g.dvUsed ?? 0)} m/s of descent. ` +
        'The real Vikram touched down on 23 August 2023 at 12:33 UTC, inside its 2 m/s limit.'
      : (sim.reason ?? 'The lander was lost.');
    resultEl.innerHTML = `<h2>${ok ? (g?.hard ? 'Hard landing' : 'Vikram has landed') : 'Lander lost'}</h2><p>${detail}</p>`;
    const again = document.createElement('button');
    again.className = 'sfb-btn sfb-btn-primary';
    again.textContent = 'Fly the descent again';
    again.onclick = () => startDescent();
    const look = document.createElement('button');
    look.className = 'sfb-btn';
    look.textContent = 'Look around';
    look.style.marginLeft = '6px';
    look.onclick = () => { resultEl.style.display = 'none'; };
    resultEl.append(again, look);
    resultEl.style.display = 'block';
    refreshDock();
  }
}

interface DescentHud {
  nodes: Node[]; phase: HTMLElement; site: HTMLElement;
  alt: HudRow; rate: HudRow; ground: HudRow; aim: HudRow; tilt: HudRow; twr: HudRow; hazard: HudRow;
  mass: HudRow; dv: HudRow; sun: HudRow; prop: HudRow; propBar: HTMLElement; thr: HudRow; thrBar: HTMLElement;
  control: HudRow; warp: HudRow;
}
let descentHud: DescentHud | null = null;
function buildDescentHud(): DescentHud {
  const phase = hudEl('div', null, 'phase'), site = hudEl('div', null, 'site'), main = hudEl('table', null);
  const nodes: Node[] = [phase, site, main];
  const table = () => { const tb = hudEl('table', null); nodes.push(tb); return tb; };
  const alt = hudRow(main, 'Altitude'), rate = hudRow(main, 'Descent rate'), ground = hudRow(main, 'Ground speed');
  const aim = hudRow(main, 'Ignition in'); // or 'Range to target' once the engine has lit
  const tilt = hudRow(main, 'Tilt'), twr = hudRow(main, 'Thrust / weight'), hazard = hudRow(main, 'Ground below');
  const mass = hudRow(main, 'Mass'), dv = hudRow(main, 'Delta-v left'), sun = hudRow(main, 'Sun elevation');
  const prop = hudRow(table(), 'Propellant'), propBar = hudBar(nodes);
  const thr = hudRow(table(), 'Throttle'), thrBar = hudBar(nodes);
  const ctl = table();
  const control = hudRow(ctl, 'Control'), warpRow = hudRow(ctl, 'Time warp');
  return { nodes, phase, site, alt, rate, ground, aim, tilt, twr, hazard, mass, dv, sun, prop, propBar, thr, thrBar, control, warp: warpRow };
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

function button(label: string, on: boolean, fn: () => void, title = '', disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sfb-btn';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  if (on) b.classList.add('on', 'is-active');
  b.onclick = () => { fn(); b.blur(); refreshDock(); };
  dock.appendChild(b);
  return b;
}

/** Hide or show the readout panels so the spacecraft has the whole screen. */
function togglePanels(): void {
  document.body.classList.toggle('hud-off');
}
/** Steering takes over from the autopilot the moment the pilot touches a control. */
function takeManual(): void {
  if (sim && sim.mode === 'AUTO') sim.setMode('MANUAL');
}

/** The journey's time scrubber; recreated with the dock, null when the dock has none. */
let scrubEl: HTMLInputElement | null = null;
function refreshDock(): void {
  // Rebuilding the dock drops any steering button that is being held down.
  touchHeld.clear();
  dock.textContent = '';
  scrubEl = null;
  if (mode === 'descent' && !sim) return; // hand-off to the descent is still building the sim
  const help = document.createElement('div');
  help.id = 'help';
  help.style.flexBasis = '100%';
  help.style.textAlign = 'center';
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  if (mode === 'cruise') {
    button(cruisePlaying ? 'Pause' : 'Play', false, () => { cruisePlaying = !cruisePlaying; });
    for (const [w, label] of CRUISE_WARPS) button(label, cruiseWarp === w, () => { cruiseWarp = w; cruisePlaying = true; }, 'Playback speed (slows while an engine fires)');
    button('Next burn', false, () => {
      const e = rec.events.find((x) => x.burn && x.t - x.burn - 90 > cruiseT + 1);
      cruiseT = e ? e.t - e.burn! - 90 : rec.handoff.t - 60;
      cruisePlaying = true;
    }, 'Jump to just before the next engine burn');
    button('Earth', focus === 'earth' && !focusAuto, () => setFocus('earth', false), 'Centre the view on Earth');
    button('Moon', focus === 'moon' && !focusAuto, () => setFocus('moon', false), 'Centre the view on the Moon');
    button('Spacecraft', focus === 'craft', () => setFocus('craft', false), 'Follow the spacecraft');
    button('Auto view', focusAuto, () => { focusAuto = true; userZoomed = false; }, 'Follow whichever body is being orbited');
    button('Go to descent', false, () => enterDescent(), 'Skip to the powered descent');
    button(document.body.classList.contains('hud-off') ? 'Show panels' : 'Hide panels', false, () => togglePanels(), 'H');
    const scrub = document.createElement('input');
    scrub.type = 'range'; scrub.id = 'scrub'; scrub.min = '0'; scrub.max = '1000';
    scrub.setAttribute('aria-label', 'Mission time');
    scrub.style.flexBasis = '100%';
    scrub.oninput = () => { cruiseT = rec.t[0] + (Number(scrub.value) / 1000) * (rec.handoff.t - rec.t[0]); };
    dock.appendChild(scrub);
    scrubEl = scrub;
    help.textContent = `${coarse ? 'Drag to look, pinch to zoom.' : 'Drag to look, scroll to zoom.'} Orange marks engine burns. Every position comes from integrating gravity and thrust, from the launcher's cutoff onward.`;
    dock.appendChild(help);
    return;
  }

  if (sim) applyKeys();
  const over = sim.phase === 'LANDED' || sim.phase === 'CRASHED';
  button('Skip to ignition', autoWarp && sim.phase === 'COAST', () => { autoWarp = !autoWarp; }, 'Fast-forward the coast to powered descent', sim.phase !== 'COAST' || sim.mode !== 'AUTO');
  button('Autopilot', sim.mode === 'AUTO', () => sim.setMode('AUTO'), 'T', over);
  button('Manual', sim.mode === 'MANUAL', () => sim.setMode('MANUAL'), 'T', over);
  // The flight controls are always on the dock during the descent: using one takes over
  // from the autopilot, so there is no separate step to find first.
  if (!over) {
    button('Thrust −', false, () => { takeManual(); sim.setThrottle(sim.level - 0.1); }, 'Q');
    button('Thrust +', false, () => { takeManual(); sim.setThrottle(Math.max(sim.level, 0.2) + 0.1); }, 'E');
    button('Hold up', sim.hold === 'UP', () => { takeManual(); sim.setHold(sim.hold === 'UP' ? null : 'UP'); }, 'F');
    button('Hold retro', sim.hold === 'RETRO', () => { takeManual(); sim.setHold(sim.hold === 'RETRO' ? null : 'RETRO'); }, 'R');
    // Steering for touch screens: press and hold, the same as holding W/S/A/D.
    const steer = (label: string, key: string, title: string) => {
      const b = document.createElement('button');
      b.className = 'sfb-btn';
      b.textContent = label;
      b.title = title;
      b.style.touchAction = 'none';
      const set = (on: boolean) => {
        if (on) takeManual();
        if (on) touchHeld.add(key);
        else touchHeld.delete(key);
        b.classList.toggle('on', on);
        b.classList.toggle('is-active', on);
        applyKeys();
      };
      b.onpointerdown = (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); set(true); };
      b.onpointerup = () => { set(false); if (touchHeld.size === 0) refreshDock(); };
      b.onpointercancel = () => set(false);
      b.oncontextmenu = (e) => e.preventDefault();
      dock.appendChild(b);
    };
    steer('Pitch ▲', 'w', 'W');
    steer('Pitch ▼', 's', 'S');
    steer('Roll ◀', 'a', 'A');
    steer('Roll ▶', 'd', 'D');
  }
  for (const w of WARPS) button(`×${w}`, warp === w && !(autoWarp && sim.phase === 'COAST'), () => { warp = w; autoWarp = false; }, 'Time warp (limited near the ground)', over);
  button('Restart descent', false, () => startDescent());
  button('Replay journey', false, () => startCruise(), 'Back to the flight from Earth');
  button(document.body.classList.contains('hud-off') ? 'Show panels' : 'Hide panels', false, () => togglePanels(), 'H');
  help.textContent = coarse
    ? 'Drag to look, pinch to zoom. Hold Pitch or Roll to steer; touching a control takes over from the autopilot.'
    : 'Fly it yourself: W/S pitch · A/D roll · E/Q throttle · Z full · X cut · F hold up · R hold retrograde · T autopilot on/off · H hide panels';
  dock.appendChild(help);
}

const held = new Set<string>();
const MANUAL_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'e', 'q', 'z', 'x', 'f', 'r']);
const touchHeld = new Set<string>(); // on-screen steering buttons being pressed
function applyKeys(): void {
  const k = (a: string, b: string) => (held.has(a) || held.has(b) || touchHeld.has(a) ? 1 : 0);
  sim.setInput({
    pitch: k('w', 'arrowup') - k('s', 'arrowdown'),
    roll: k('d', 'arrowright') - k('a', 'arrowleft'),
    thr: k('e', 'shift') - k('q', 'control'),
  });
}
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
  if (key === 'h' && !e.repeat && !typing) { togglePanels(); refreshDock(); return; }
  if (e.repeat || !sim || mode !== 'descent') return;
  held.add(key);
  if (MANUAL_KEYS.has(key)) takeManual();
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
  if (sim && mode === 'descent') applyKeys();
});
window.addEventListener('blur', () => { held.clear(); if (sim && mode === 'descent') applyKeys(); });

// ---------------------------------------------------------------- loop
function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  for (const c of [camera, cCamera]) { c.aspect = w / h; c.updateProjectionMatrix(); }
}
window.addEventListener('resize', resize);
resize();

/** Show the "computing" note, let it paint, then do the work. */
function withBusy(text: string, work: () => void): void {
  busy.textContent = text;
  busy.style.display = 'block';
  setTimeout(() => {
    try { work(); busy.style.display = 'none'; } catch (err) { busy.textContent = `Could not continue: ${err instanceof Error ? err.message : String(err)}`; }
  }, 30);
}
function enterDescent(): void {
  if (mode === 'descent') return;
  mode = 'descent'; // stops the journey clock while the terrain is generated
  sim = undefined as unknown as LanderSim;
  touchHeld.clear();
  dock.textContent = ''; // no stale cruise buttons while the terrain is generated
  scrubEl = null;
  withBusy('Generating the landing site…', startDescent);
}

let last = performance.now();
let lastPhase = '';
let lastHud = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!rec) return;
  const hudDue = now - lastHud > 90;
  if (mode === 'cruise') {
    if (cruisePlaying) cruiseT += dt * (cruiseNow?.burning ? Math.min(cruiseWarp, BURN_WARP) : cruiseWarp);
    if (cruiseT >= rec.handoff.t) { cruiseT = rec.handoff.t; placeCruise(dt); enterDescent(); return; }
    placeCruise(dt);
    cControls.update();
    cCamera.near = Math.max(20, cCamera.position.distanceTo(cControls.target) * 0.01);
    cCamera.updateProjectionMatrix();
    if (hudDue) { lastHud = now; updateCruiseHud(); }
    renderer.render(cScene, cCamera);
    return;
  }
  if (!sim) return;
  sim.advance(dt * effectiveWarp());
  if (sim.phase !== lastPhase) {
    lastPhase = sim.phase;
    if (sim.phase !== 'COAST') autoWarp = false;
    refreshDock();
  }
  place(dt);
  dControls.update();
  // Keep the near plane tight when close so the lander does not clip, loose when far for depth precision.
  tmp.copy(camera.position);
  camera.near = Math.max(0.3, tmp.length() * 0.02);
  camera.updateProjectionMatrix();
  if (hudDue) { lastHud = now; updateHud(); }
  renderer.render(scene, camera);
}

const CRUISE_BUSY = 'Flying Chandrayaan-3 from Earth orbit to the Moon…';
busy.textContent = CRUISE_BUSY;
busy.style.display = 'block';
runCruise((text) => { busy.textContent = text; })
  .then((r) => {
    rec = r;
    eph = createMoonEphemeris(rec.epochJD);
    buildCruiseScene();
    if (new URLSearchParams(window.location.search).get('stage') === 'descent') startDescent();
    else startCruise();
    busy.style.display = 'none';
  })
  .catch((err) => { busy.textContent = `Could not continue: ${err instanceof Error ? err.message : String(err)}`; });
requestAnimationFrame(frame);

// Handle for the browser console and automated checks: astraLanding.sim().advance(60).
(window as unknown as { astraLanding: unknown }).astraLanding = {
  sim: () => sim,
  cruise: () => rec,
  mode: () => mode,
  cruiseTime: (t?: number) => { if (t !== undefined) cruiseT = t; return cruiseT; },
  descend: () => enterDescent(),
};
