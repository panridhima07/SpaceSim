// Scroll-driven "fall from the galaxy to Earth" backdrop for the login screen.
// The host owns scrolling and feeds a progress value 0..1; this module renders four
// layers (star sky, galaxy, fly-through, solar system + Earth) and projects text labels.

import * as THREE from 'three';
import { buildStarBuffers, bvToRgb } from '../world/skyData';
import './journey.css';

export interface JourneySite { id: string; label: string; latDeg: number; lonDeg: number; kind: 'orbit' | 'return'; }
export interface Journey {
  /** Fixed full-viewport layer holding the canvas and the text labels. The host appends it. */
  el: HTMLElement;
  /** Target progress 0..1. The module eases toward it. */
  setProgress(p: number): void;
  /** Set progress with no easing (used to start at the end). */
  jumpTo(p: number): void;
  /** Turn the Earth so this launch site faces the camera and highlight its arc; null restores the default view. */
  focusSite(id: string | null): void;
  /** Called every rendered frame with the eased progress. */
  onFrame: ((p: number) => void) | null;
  dispose(): void;
}

// ---------------------------------------------------------------- helpers

const ASSETS = './assets/space/';
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const SUN_LOCAL = new THREE.Vector3(28, 0.3, 43.7); // the Sun's place in the galaxy layer
const EARTH_POS = new THREE.Vector3(400, 0, 0);
const CAM_DIR_START = new THREE.Vector3(0.35, 0.62, 0.7).normalize();
const CAM_DIR_FINAL = new THREE.Vector3(-1, -0.2, 0.55).normalize();
const DEFAULT_LON = 62 * DEG;
const ZERO = new THREE.Vector3();

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rng: () => number) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(TAU * rng());

interface Disposable { dispose(): void; }
/** Collects everything that needs disposing when the journey ends. */
class Bin {
  private items: Disposable[] = [];
  add<T extends Disposable>(x: T): T { this.items.push(x); return x; }
  clear(): void { for (const i of this.items) i.dispose(); this.items.length = 0; }
}

interface View { w: number; h: number; aspect: number; fx: number; fy: number; dFinal: number; }
interface Ctx {
  bin: Bin;
  uPx: { value: number };
  view: View;
  labels: HTMLElement;
  dot: THREE.Texture;
  isDisposed(): boolean;
  loadTex(name: string, srgb: boolean, onLoad: (t: THREE.Texture) => void): void;
  /** Runs fn now if the deferred loads were released, otherwise once they are. */
  defer(fn: () => void): void;
}

const projScratch = new THREE.Vector3();
/** A DOM label that follows a 3D point. */
class Tag {
  private shown = false;
  readonly el: HTMLSpanElement;
  constructor(parent: HTMLElement, text: string, cls: string) {
    this.el = document.createElement('span');
    this.el.className = `auth-label ${cls}`;
    this.el.textContent = text;
    parent.appendChild(this.el);
  }
  place(world: THREE.Vector3, cam: THREE.PerspectiveCamera, alpha: number, view: View): void {
    projScratch.copy(world).applyMatrix4(cam.matrixWorldInverse);
    if (alpha < 0.01 || projScratch.z >= 0) { this.hide(); return; }
    projScratch.applyMatrix4(cam.projectionMatrix);
    const x = (projScratch.x * 0.5 + 0.5) * view.w;
    const y = (-projScratch.y * 0.5 + 0.5) * view.h;
    this.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    this.el.style.opacity = alpha.toFixed(3);
    if (!this.shown) { this.el.style.visibility = 'visible'; this.shown = true; }
  }
  hide(): void {
    if (this.shown) { this.el.style.visibility = 'hidden'; this.shown = false; }
  }
}

function dotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 64);
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.45, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(c);
}

function glowTexture(inner: string, mid: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.25, mid);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function flatTexture(bin: Bin, r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return bin.add(t);
}

// ---------------------------------------------------------------- layer 1: star sky

function buildSky(ctx: Ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
  const mats = [1.8, 2.6].map((size) => ctx.bin.add(new THREE.PointsMaterial({
    size, sizeAttenuation: false, vertexColors: true, transparent: true,
    depthTest: false, depthWrite: false, alphaMap: ctx.dot,
  })));

  ctx.defer(() => {
    fetch(`${ASSETS}stars.6.json`)
      .then((r) => r.json())
      .then((json) => {
        if (ctx.isDisposed()) return;
        const { faint, bright } = buildStarBuffers(json, 1000);
        [faint, bright].forEach((b, i) => {
          const geo = ctx.bin.add(new THREE.BufferGeometry());
          geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
          geo.setAttribute('color', new THREE.BufferAttribute(b.colors, 3));
          const pts = new THREE.Points(geo, mats[i]);
          pts.frustumCulled = false;
          scene.add(pts);
        });
      })
      .catch(() => { /* the sky layer just stays empty */ });
  });

  return {
    scene, camera,
    setOpacity(o: number) { for (const m of mats) m.opacity = o; },
  };
}

// ---------------------------------------------------------------- layer 2: galaxy

const GALAXY_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPx;
  uniform float uOpacity;
  varying vec3 vC;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    gl_PointSize = clamp(aSize * uPx * 260.0 / dist, 1.0 * uPx, 5.0 * uPx);
    vA = uOpacity * clamp(dist / 6.0, 0.0, 1.0);
    vC = aColor;
    gl_Position = projectionMatrix * mv;
  }
`;
const SOFT_DOT_FRAG = /* glsl */ `
  varying vec3 vC;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    gl_FragColor = vec4(vC, smoothstep(1.0, 0.0, d) * vA);
  }
`;

function galaxyPoints(): { pos: Float32Array; col: Float32Array; size: Float32Array } {
  const rng = mulberry32(7);
  const BULGE = 8000, ARMS = 48000, HAZE = 14000;
  const total = BULGE + ARMS + HAZE + 1;
  const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), size = new Float32Array(total);
  let n = 0;
  const put = (x: number, y: number, z: number, r: number, g: number, b: number, s: number) => {
    pos.set([x, y, z], n * 3);
    col.set([r, g, b], n * 3);
    size[n++] = s;
  };

  for (let i = 0; i < BULGE; i++) {
    const k = 0.5 + 0.5 * rng();
    put(gauss(rng) * 7, gauss(rng) * 3.5, gauss(rng) * 5, 1.0 * k, 0.85 * k, 0.6 * k, 0.8 + rng() * 1.2);
  }

  // Four logarithmic arms: two strong, two weaker.
  const armOffset = [0, Math.PI, Math.PI / 2, Math.PI * 1.5];
  for (let i = 0; i < ARMS; i++) {
    const u = rng();
    const arm = u < 0.3 ? 0 : u < 0.6 ? 1 : u < 0.8 ? 2 : 3;
    let r: number;
    do { r = 6 - Math.log(1 - rng()) * 32; } while (r > 100);
    const a = armOffset[arm] + 4.5 * Math.log(r / 8) + gauss(rng) * 0.22;
    const rr = r + gauss(rng) * 2.5;
    const k = 0.4 + 0.6 * rng();
    const pink = rng() < 0.05;
    // Amber near the core, teal toward the rim; one in twenty is a pale warm spark.
    const t = Math.min(1, Math.max(0, (r - 14) / 60));
    put(rr * Math.cos(a), gauss(rng) * 1.2, rr * Math.sin(a),
      (pink ? 1.0 : 1.0 - 0.68 * t) * k, (pink ? 0.9 : 0.6 + 0.2 * t) * k, (pink ? 0.8 : 0.28 + 0.5 * t) * k, 0.7 + rng() * 1.3);
  }

  for (let i = 0; i < HAZE; i++) {
    const r = 100 * Math.sqrt(rng());
    const a = rng() * TAU;
    put(r * Math.cos(a), gauss(rng) * 2, r * Math.sin(a), 0.25, 0.22, 0.15, 1.5 + rng());
  }

  // One brighter dot marks the Sun.
  put(SUN_LOCAL.x, SUN_LOCAL.y, SUN_LOCAL.z, 1.0, 0.9, 0.6, 6);
  return { pos, col, size };
}

function buildGalaxy(ctx: Ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 3000);
  const { pos, col, size } = galaxyPoints();
  const geo = ctx.bin.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = ctx.bin.add(new THREE.ShaderMaterial({
    uniforms: { uPx: ctx.uPx, uOpacity: { value: 1 } },
    vertexShader: GALAXY_VERT, fragmentShader: SOFT_DOT_FRAG,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
  }));
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  const glowMat = ctx.bin.add(new THREE.SpriteMaterial({
    map: ctx.bin.add(glowTexture('rgba(255,215,160,0.9)', 'rgba(255,170,90,0.35)')),
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
  }));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(46);
  scene.add(glow);

  const sunTag = new Tag(ctx.labels, 'THE SUN · ORION ARM', 'auth-label--here');
  const dir = new THREE.Vector3();
  // First view: the disc seen face-on, upright on the page. Scrolling tips it over into
  // the inclined view (dirA) that the rest of the fall starts from.
  const dirFace = new THREE.Vector3(0, 1, 0.1).normalize();
  const dirA = new THREE.Vector3(0, 0.5, 0.87);
  const dirStart = new THREE.Vector3();
  const dirB = new THREE.Vector3(0.3, 0.8, 0.5);
  const target = new THREE.Vector3();

  return {
    scene, camera,
    update(p: number, t: number, opacity: number) {
      const qa = clamp01(p / 0.3);
      const e = smooth(0, 1, qa);
      const d0 = 330 * Math.max(1, 0.9 / ctx.view.aspect);
      target.copy(ZERO).lerp(SUN_LOCAL, smooth(0.05, 0.6, qa));
      dirStart.lerpVectors(dirFace, dirA, smooth(0, 0.4, qa)).normalize();
      dir.lerpVectors(dirStart, dirB, e).normalize();
      const sway = Math.sin(t * 0.1) * 0.05;
      const cs = Math.cos(sway), sn = Math.sin(sway);
      dir.set(dir.x * cs + dir.z * sn, dir.y, -dir.x * sn + dir.z * cs);
      const dist = Math.exp(lerp(Math.log(d0), Math.log(0.8), e));
      camera.position.copy(target).addScaledVector(dir, dist);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      mat.uniforms.uOpacity.value = opacity;
      glowMat.opacity = 0.8 * opacity;
      sunTag.place(SUN_LOCAL, camera, smooth(0.03, 0.08, p) * (1 - smooth(0.18, 0.24, p)), ctx.view);
    },
  };
}

// ---------------------------------------------------------------- layer 3: fly-through

const FLIGHT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPx;
  uniform float uOpacity;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform vec2 uFar;
  varying vec3 vC;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    gl_PointSize = clamp(aSize * uPx * 110.0 / dist, uMinPx * uPx, uMaxPx * uPx);
    vA = uOpacity * (1.0 - smoothstep(uFar.x, uFar.y, dist)) * smoothstep(3.0, 8.0, dist);
    vC = aColor;
    gl_Position = projectionMatrix * mv;
  }
`;
const FIELD_FRAG = /* glsl */ `
  varying vec3 vC;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    gl_FragColor = vec4(vC, smoothstep(1.0, 0.0, d) * min(1.0, vA * 1.8));
  }
`;
// Named stars: bright core with a soft halo.
const NAMED_FRAG = /* glsl */ `
  varying vec3 vC;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.15, 0.35, d);
    float halo = pow(max(1.0 - d, 0.0), 2.0) * 0.7;
    gl_FragColor = vec4(mix(vC, vec3(1.0), core * 0.6), clamp(core + halo, 0.0, 1.0) * vA);
  }
`;

interface NamedStar { name: string; pos: THREE.Vector3; color: [number, number, number]; size: number; }
const NAMED_STARS: NamedStar[] = [
  { name: "BARNARD'S STAR · 6 LY", pos: new THREE.Vector3(-6, 4, -150), color: [1.0, 0.55, 0.4], size: 60 },
  { name: 'SIRIUS · 8.6 LY', pos: new THREE.Vector3(7, 3, -300), color: [0.75, 0.85, 1.0], size: 70 },
  { name: 'ALPHA CENTAURI · 4.4 LY', pos: new THREE.Vector3(-5, -2.5, -560), color: [1.0, 0.95, 0.8], size: 65 },
];

function buildFlight(ctx: Ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  const rng = mulberry32(11);
  const N = 6000;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let x: number, y: number;
    do { x = (rng() * 2 - 1) * 90; y = (rng() * 2 - 1) * 90; } while (Math.hypot(x, y) < 2);
    pos.set([x, y, -rng() * 900], i * 3);
    const [r, g, b] = bvToRgb(-0.2 + rng() * 1.8);
    const k = 0.75 + 0.25 * rng();
    col.set([r * k, g * k, b * k], i * 3);
    size[i] = 2 + rng() * 4;
  }

  const makeMat = (frag: string, minPx: number, maxPx: number, far: [number, number]) => ctx.bin.add(new THREE.ShaderMaterial({
    uniforms: {
      uPx: ctx.uPx, uOpacity: { value: 0 }, uMinPx: { value: minPx }, uMaxPx: { value: maxPx },
      uFar: { value: new THREE.Vector2(far[0], far[1]) },
    },
    vertexShader: FLIGHT_VERT, fragmentShader: frag,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
  }));
  const fieldMat = makeMat(FIELD_FRAG, 1.5, 28, [350, 500]);
  const namedMat = makeMat(NAMED_FRAG, 14, 18, [700, 900]);
  const makePoints = (p: Float32Array, c: Float32Array, s: Float32Array, mat: THREE.ShaderMaterial) => {
    const geo = ctx.bin.add(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(s, 1));
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
  };
  makePoints(pos, col, size, fieldMat);
  makePoints(
    new Float32Array(NAMED_STARS.flatMap((s) => s.pos.toArray())),
    new Float32Array(NAMED_STARS.flatMap((s) => s.color)),
    new Float32Array(NAMED_STARS.map((s) => s.size)),
    namedMat,
  );

  const tags = NAMED_STARS.map((s) => new Tag(ctx.labels, s.name, 'auth-label--star'));

  return {
    scene, camera,
    update(p: number, opacity: number) {
      const qf = clamp01((p - 0.22) / 0.28);
      camera.position.set(0, 0, -820 * smooth(0, 1, qf));
      camera.updateMatrixWorld();
      fieldMat.uniforms.uOpacity.value = opacity;
      namedMat.uniforms.uOpacity.value = opacity;
      NAMED_STARS.forEach((s, i) => {
        const dist = camera.position.distanceTo(s.pos);
        const a = smooth(15, 40, dist) * (1 - smooth(110, 160, dist));
        tags[i].place(s.pos, camera, a * opacity, ctx.view);
      });
    },
  };
}

// ---------------------------------------------------------------- layer 4: Earth

const EARTH_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uSpec;
  uniform vec3 uSunDir;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    float day = smoothstep(-0.12, 0.25, dot(N, uSunDir));
    vec3 dayC = texture2D(uDay, vUv).rgb;
    vec3 nightC = texture2D(uNight, vUv).rgb;
    float ocean = texture2D(uSpec, vUv).r;
    vec3 H = normalize(uSunDir + V);
    float nh = max(dot(N, H), 0.0);
    vec3 col = dayC * mix(0.03, 1.1, day) + nightC * (1.0 - day) * 1.4;
    col += ocean * (pow(nh, 60.0) * 1.2 + pow(nh, 12.0) * 0.25) * vec3(1.0, 0.92, 0.8) * day;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    col += rim * vec3(0.3, 0.55, 1.0) * 0.7 * (0.3 + 0.7 * day);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;
const HALO_VERT = /* glsl */ `
  uniform vec3 uSunDir;
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vSun;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vP = mv.xyz;
    vN = normalize(normalMatrix * normal);
    vSun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const HALO_FRAG = /* glsl */ `
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vSun;
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(-vP);
    float i = pow(clamp(-dot(N, V), 0.0, 1.0), 3.0) * 2.5;
    float lit = 0.25 + 0.75 * smoothstep(-0.2, 0.6, dot(N, vSun));
    gl_FragColor = vec4(0.3, 0.55, 1.0, i * lit);
  }
`;
const SWARM_VERT = /* glsl */ `
  attribute vec4 aOrb;   // radius, inclination, raan, phase
  attribute vec2 aSp;    // angular speed, size in px
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPx;
  uniform float uDist;
  uniform float uFinal;
  varying vec3 vC;
  void main() {
    float a = aOrb.w + uTime * aSp.x;
    vec3 p = vec3(cos(a), 0.0, sin(a)) * aOrb.x;
    float ci = cos(aOrb.y), si = sin(aOrb.y);
    p = vec3(p.x, p.y * ci - p.z * si, p.y * si + p.z * ci);
    float cr = cos(aOrb.z), sr = sin(aOrb.z);
    p = vec3(p.x * cr + p.z * sr, p.y, -p.x * sr + p.z * cr);
    gl_PointSize = aSp.y * uPx * clamp(uFinal / uDist, 0.3, 1.0);
    vC = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const SWARM_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vC;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    gl_FragColor = vec4(vC * 1.15, (1.0 - smoothstep(0.5, 1.0, d)) * uOpacity);
  }
`;
const ARC_VERT = /* glsl */ `
  attribute float aT;
  varying float vT;
  void main() {
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ARC_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uOffset;
  uniform float uGain;
  varying float vT;
  void main() {
    float head = mod(uTime * 0.16 + uOffset, 1.5);
    float tail = vT < head ? exp(-(head - vT) * 6.0) : 0.0;
    float a = max(tail, 0.07) * uGain;
    gl_FragColor = vec4(1.0, 0.92, 0.78, a);
  }
`;

/** Position on an orbit: (cos a, 0, sin a) * radius, tilted about X by inc, then turned about Y by raan. */
function orbitPoint(radius: number, inc: number, raan: number, phase: number, speed: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const a = phase + t * speed;
  const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
  const ci = Math.cos(inc), si = Math.sin(inc);
  const y2 = -z * si, z2 = z * ci;
  const cr = Math.cos(raan), sr = Math.sin(raan);
  return out.set(x * cr + z2 * sr, y2, -x * sr + z2 * cr);
}

interface NamedSat { name: string; radius: number; inc: number; raan: number; phase: number; speed: number; }
const NAMED_SATS: NamedSat[] = [
  { name: 'ISS', radius: 1.064, inc: 51.6 * DEG, raan: 0.6, phase: 0.5, speed: 0.07 },
  { name: 'HUBBLE', radius: 1.083, inc: 28.5 * DEG, raan: 2.1, phase: 2.5, speed: 0.06 },
  { name: 'TIANGONG', radius: 1.061, inc: 41.5 * DEG, raan: 4.0, phase: 4.4, speed: 0.07 },
  { name: 'STARLINK-5123', radius: 1.086, inc: 53 * DEG, raan: 5.2, phase: 1.3, speed: 0.06 },
];

function buildSwarm(ctx: Ctx) {
  const rng = mulberry32(23);
  const shell = 2600, high = 40, ring = 220;
  const n = shell + high + ring;
  const orb = new Float32Array(n * 4), sp = new Float32Array(n * 2), col = new Float32Array(n * 3);
  const planes = [53, 43, 70, 97.6];
  for (let i = 0; i < n; i++) {
    let radius: number, inc: number, speed: number;
    if (i < shell) {
      radius = 1.05 + rng() * 0.11;
      const u = rng();
      inc = (u < 0.88 ? planes[Math.min(3, Math.floor(u / 0.22))] + gauss(rng) * 1.2 : rng() * 180) * DEG;
      speed = 0.05 * (0.7 + 0.6 * rng());
    } else if (i < shell + high) {
      radius = 4.17; inc = 55 * DEG; speed = 0.01;
    } else {
      radius = 6.61; inc = 0; speed = 0;
    }
    orb.set([radius, inc, rng() * TAU, rng() * TAU], i * 4);
    sp.set([speed, 1.3 + rng() * 1.3], i * 2);
    col.set(rng() < 0.12 ? [0.8, 0.9, 1.0] : [1.0, 0.86, 0.62], i * 3);
  }
  const geo = ctx.bin.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aOrb', new THREE.BufferAttribute(orb, 4));
  geo.setAttribute('aSp', new THREE.BufferAttribute(sp, 2));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = ctx.bin.add(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPx: ctx.uPx, uDist: { value: 1 }, uFinal: { value: 1 }, uOpacity: { value: 0 } },
    vertexShader: SWARM_VERT, fragmentShader: SWARM_FRAG,
    transparent: true, depthTest: true, depthWrite: false,
  }));
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, mat };
}

interface SiteBasis { s: THREE.Vector3; e: THREE.Vector3; }

function siteBasis(site: JourneySite): SiteBasis {
  const lat = site.latDeg * DEG, lon = site.lonDeg * DEG;
  return {
    s: new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)),
    e: new THREE.Vector3(-Math.sin(lon), 0, -Math.cos(lon)),
  };
}

/** Launch trajectory in Earth-mesh local space, t in 0..1. */
function arcPoint(kind: JourneySite['kind'], b: SiteBasis, t: number, out: THREE.Vector3): THREE.Vector3 {
  const phi = kind === 'orbit' ? 0.55 * Math.pow(t, 1.3) : 0.12 * Math.sin(Math.PI * t);
  const h = kind === 'orbit' ? 0.075 * (1 - Math.pow(1 - t, 2.2)) : 0.11 * Math.sin(Math.PI * Math.pow(t, 0.7));
  out.copy(b.s).multiplyScalar(Math.cos(phi)).addScaledVector(b.e, Math.sin(phi));
  // A hair above the surface so the pad end does not fight the globe in the depth buffer.
  return out.multiplyScalar(1.003 + h);
}

function pointsOf(ctx: Ctx, count: number, size: number) {
  const geo = ctx.bin.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const mat = ctx.bin.add(new THREE.PointsMaterial({
    size, sizeAttenuation: false, vertexColors: true, transparent: true, alphaMap: ctx.dot,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function buildEarth(ctx: Ctx, sites: JourneySite[]) {
  const { bin } = ctx;
  const group = new THREE.Group();
  group.position.copy(EARTH_POS);

  const uniforms = {
    uDay: { value: flatTexture(bin, 24, 54, 108, true) as THREE.Texture },
    uNight: { value: flatTexture(bin, 0, 0, 0, true) as THREE.Texture },
    uSpec: { value: flatTexture(bin, 0, 0, 0, false) as THREE.Texture },
    uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
  };
  ctx.loadTex('earth_atmos_2048.jpg', true, (t) => { uniforms.uDay.value = t; });
  ctx.loadTex('earth_lights_2048.png', true, (t) => { uniforms.uNight.value = t; });
  ctx.loadTex('earth_specular_2048.jpg', false, (t) => { uniforms.uSpec.value = t; });
  const mesh = new THREE.Mesh(
    bin.add(new THREE.SphereGeometry(1, 96, 64)),
    bin.add(new THREE.ShaderMaterial({ uniforms, vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG })),
  );
  group.add(mesh);

  const cloudMat = bin.add(new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false, visible: false }));
  ctx.loadTex('earth_clouds_1024.png', true, (t) => { cloudMat.map = t; cloudMat.visible = true; cloudMat.needsUpdate = true; });
  const clouds = new THREE.Mesh(bin.add(new THREE.SphereGeometry(1.008, 64, 48)), cloudMat);
  mesh.add(clouds);

  group.add(new THREE.Mesh(
    bin.add(new THREE.SphereGeometry(1.15, 64, 48)),
    bin.add(new THREE.ShaderMaterial({
      uniforms: { uSunDir: uniforms.uSunDir }, vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    })),
  ));

  const moonMat = bin.add(new THREE.MeshLambertMaterial({ color: 0x8a8a8a }));
  ctx.loadTex('moonmap1k.jpg', true, (t) => { moonMat.map = t; moonMat.color.set(0xffffff); moonMat.needsUpdate = true; });
  const moon = new THREE.Mesh(bin.add(new THREE.SphereGeometry(0.27, 32, 24)), moonMat);
  moon.position.set(6, 1.5, -7);
  group.add(moon);

  const swarm = buildSwarm(ctx);
  group.add(swarm.points);

  // Named satellites, drawn as larger dots with DOM labels.
  const satDots = pointsOf(ctx, NAMED_SATS.length, 4);
  const satPos = satDots.geometry.getAttribute('position') as THREE.BufferAttribute;
  const satCol = satDots.geometry.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < NAMED_SATS.length; i++) satCol.setXYZ(i, 1, 0.85, 0.85);
  group.add(satDots);
  const satLocal = NAMED_SATS.map(() => new THREE.Vector3());

  // Launch arcs turn with the Earth mesh.
  const bases = sites.map(siteBasis);
  const arcMats = sites.map((site, i) => {
    const N = 96;
    const pos = new Float32Array(N * 3), aT = new Float32Array(N);
    const v = new THREE.Vector3();
    for (let k = 0; k < N; k++) {
      aT[k] = k / (N - 1);
      arcPoint(site.kind, bases[i], aT[k], v).toArray(pos, k * 3);
    }
    const geo = bin.add(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    const mat = bin.add(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOffset: { value: (i * 0.53) % 1.5 }, uGain: { value: 0 } },
      vertexShader: ARC_VERT, fragmentShader: ARC_FRAG,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    mesh.add(line);
    return mat;
  });
  const heads = pointsOf(ctx, sites.length, 5);
  const pads = pointsOf(ctx, sites.length, 4);
  mesh.add(heads, pads);
  const headPos = heads.geometry.getAttribute('position') as THREE.BufferAttribute;
  const headCol = heads.geometry.getAttribute('color') as THREE.BufferAttribute;
  const padPos = pads.geometry.getAttribute('position') as THREE.BufferAttribute;
  const padCol = pads.geometry.getAttribute('color') as THREE.BufferAttribute;
  const scratch = new THREE.Vector3();
  sites.forEach((_, i) => padPos.setXYZ(i, bases[i].s.x * 1.003, bases[i].s.y * 1.003, bases[i].s.z * 1.003));
  padPos.needsUpdate = true;

  return {
    group, mesh,
    /** Unit surface normal of each site in Earth-mesh local space. */
    siteNormals: bases.map((b) => b.s),
    satLocal,
    update(t: number, theta: number, swarmOp: number, camDist: number, dFinal: number, focus: number[]) {
      mesh.rotation.y = theta;
      clouds.rotation.y = t * 0.008;
      swarm.mat.uniforms.uTime.value = t;
      swarm.mat.uniforms.uDist.value = camDist;
      swarm.mat.uniforms.uFinal.value = dFinal;
      swarm.mat.uniforms.uOpacity.value = swarmOp;
      (satDots.material as THREE.PointsMaterial).opacity = swarmOp;
      NAMED_SATS.forEach((s, i) => {
        orbitPoint(s.radius, s.inc, s.raan, s.phase, s.speed, t, satLocal[i]);
        satPos.setXYZ(i, satLocal[i].x, satLocal[i].y, satLocal[i].z);
      });
      satPos.needsUpdate = true;
      sites.forEach((site, i) => {
        const boost = swarmOp * (1 + 1.5 * focus[i]);
        const mat = arcMats[i];
        mat.uniforms.uTime.value = t;
        mat.uniforms.uGain.value = boost;
        const head = (t * 0.16 + mat.uniforms.uOffset.value) % 1.5;
        arcPoint(site.kind, bases[i], Math.min(head, 1), scratch);
        headPos.setXYZ(i, scratch.x, scratch.y, scratch.z);
        const on = head <= 1 ? boost : 0;
        headCol.setXYZ(i, on, on * 0.95, on * 0.85);
        const pad = boost * 0.8;
        padCol.setXYZ(i, pad, pad * 0.9, pad * 0.75);
      });
      headPos.needsUpdate = headCol.needsUpdate = padCol.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- layer 4: solar system

interface PlanetDef { name: string; tex: string; flat: number; orbit: number; radius: number; angle: number; ring?: boolean; }
const PLANETS: PlanetDef[] = [
  { name: 'MERCURY', tex: 'mercurymap.jpg', flat: 0x9a948c, orbit: 150, radius: 7, angle: 2.1 },
  { name: 'VENUS', tex: 'venusmap.jpg', flat: 0xd9b27c, orbit: 270, radius: 11, angle: 4.0 },
  { name: 'MARS', tex: 'marsmap1k.jpg', flat: 0xb5593a, orbit: 560, radius: 9, angle: 5.4 },
  { name: 'JUPITER', tex: 'jupitermap.jpg', flat: 0xc9a27e, orbit: 900, radius: 34, angle: 1.0 },
  { name: 'SATURN', tex: 'saturnmap.jpg', flat: 0xd8c28f, orbit: 1250, radius: 28, angle: 3.2, ring: true },
  { name: 'URANUS', tex: 'uranusmap.jpg', flat: 0x8fd0d8, orbit: 1600, radius: 18, angle: 5.9 },
  { name: 'NEPTUNE', tex: 'neptunemap.jpg', flat: 0x3f62c8, orbit: 1900, radius: 17, angle: 2.6 },
];

/** Camera distance to its target, interpolated in log space with smoothstep inside each segment. */
function camDistance(q: number, fitK: number, dFinal: number): number {
  const knots: [number, number][] = [[0, 90000], [0.28, 4000 * fitK], [0.42, 2700 * fitK], [1, dFinal]];
  for (let i = 0; i < knots.length - 1; i++) {
    const [q0, d0] = knots[i], [q1, d1] = knots[i + 1];
    if (q <= q1) return Math.exp(lerp(Math.log(d0), Math.log(d1), smooth(q0, q1, q)));
  }
  return dFinal;
}

function circleLine(ctx: Ctx, radius: number, mat: THREE.LineBasicMaterial): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 160; i++) {
    const a = (i / 160) * TAU;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const loop = new THREE.LineLoop(ctx.bin.add(new THREE.BufferGeometry().setFromPoints(pts)), mat);
  loop.frustumCulled = false;
  return loop;
}

interface FocusState { amt: number[]; }

function buildSolar(ctx: Ctx, sites: JourneySite[]) {
  const { bin } = ctx;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 300000);

  const sunMat = bin.add(new THREE.MeshBasicMaterial({ color: 0xffc060 }));
  ctx.loadTex('sunmap.jpg', true, (t) => { sunMat.map = t; sunMat.color.set(0xffffff); sunMat.needsUpdate = true; });
  scene.add(new THREE.Mesh(bin.add(new THREE.SphereGeometry(40, 48, 32)), sunMat));
  const glowMat = bin.add(new THREE.SpriteMaterial({
    map: bin.add(glowTexture('rgba(255,255,248,1)', 'rgba(255,238,175,0.55)')),
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0,
  }));
  const glow = new THREE.Sprite(glowMat);
  scene.add(glow);
  scene.add(new THREE.PointLight(0xffffff, 3, 0, 0), new THREE.AmbientLight(0xffffff, 0.04));

  const lineMat = bin.add(new THREE.LineBasicMaterial({ color: 0x5f7fb0, transparent: true, opacity: 0, depthWrite: false }));
  scene.add(circleLine(ctx, EARTH_POS.x, lineMat));

  const bodies = PLANETS.map((def) => {
    const mat = bin.add(new THREE.MeshLambertMaterial({ color: def.flat }));
    ctx.loadTex(def.tex, true, (t) => { mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true; });
    const mesh = new THREE.Mesh(bin.add(new THREE.SphereGeometry(def.radius, 48, 32)), mat);
    mesh.position.set(Math.cos(def.angle) * def.orbit, 0, Math.sin(def.angle) * def.orbit);
    scene.add(mesh, circleLine(ctx, def.orbit, lineMat));
    if (def.ring) {
      const ring = new THREE.Mesh(
        bin.add(new THREE.RingGeometry(36, 62, 96)),
        bin.add(new THREE.MeshBasicMaterial({ color: 0xcdbb95, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })),
      );
      ring.rotation.x = -Math.PI / 2 + 0.47;
      mesh.add(ring);
    }
    return { pos: mesh.position, tag: new Tag(ctx.labels, def.name, 'auth-label--body') };
  });
  const sunTag = new Tag(ctx.labels, 'SUN', 'auth-label--body');

  const earth = buildEarth(ctx, sites);
  scene.add(earth.group);
  const earthTag = new Tag(ctx.labels, 'EARTH', 'auth-label--body auth-label--earth');
  const satTags = NAMED_SATS.map((s) => new Tag(ctx.labels, s.name, 'auth-label--sat'));
  const siteTags = sites.map((s) => new Tag(ctx.labels, s.label, 'auth-label--site'));

  const target = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const world = new THREE.Vector3();

  /** True when the Earth sphere (world radius s at EARTH_POS) hides `p` from the camera. */
  function earthBlocks(p: THREE.Vector3, s: number): boolean {
    const oc = tmp.copy(camera.position).sub(EARTH_POS);
    const ray = toCam.copy(p).sub(camera.position);
    const len = ray.length();
    ray.divideScalar(len);
    const b = oc.dot(ray);
    const disc = b * b - (oc.lengthSq() - s * s);
    if (disc <= 0) return false;
    const t = -b - Math.sqrt(disc);
    return t > 0 && t < len;
  }

  return {
    scene, camera,
    /** Moves the camera and labels for progress p. Returns nothing; call before drawing. */
    update(p: number, t: number, theta: number, focus: FocusState, focusIdx: number) {
      const view = ctx.view;
      const q = clamp01((p - 0.44) / 0.42);
      const fitK = Math.max(1, 1.45 / view.aspect);
      const d = camDistance(q, fitK, view.dFinal);
      const s = Math.exp(lerp(Math.log(12), 0, smooth(0.5, 0.9, q)));
      earth.group.scale.setScalar(s);

      target.copy(ZERO).lerp(EARTH_POS, smooth(0.34, 0.7, q));
      dir.lerpVectors(CAM_DIR_START, CAM_DIR_FINAL, smooth(0.42, 0.97, q)).normalize();
      camera.position.copy(target).addScaledVector(dir, d);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.near = Math.max(0.05, d * 0.02);
      camera.far = 300000;
      const k = smooth(0.84, 1, p);
      if (k > 0) camera.setViewOffset(view.w, view.h, (0.5 - view.fx) * view.w * k, (0.5 - view.fy) * view.h * k, view.w, view.h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      scene.updateMatrixWorld();

      glow.scale.setScalar(Math.max(220, 0.035 * camera.position.length()));
      glowMat.opacity = smooth(0.4, 0.46, p);

      const bodyAlpha = smooth(0.12, 0.28, q) * (1 - smooth(0.6, 0.8, q));
      lineMat.opacity = 0.5 * bodyAlpha;
      for (const b of bodies) b.tag.place(b.pos, camera, bodyAlpha, view);
      sunTag.place(ZERO, camera, bodyAlpha, view);

      const swarm = smooth(0.8, 0.95, q);
      earth.update(t, theta, swarm, camera.position.distanceTo(EARTH_POS), view.dFinal, focus.amt);

      const right = tmp.setFromMatrixColumn(camera.matrixWorld, 0);
      earthTag.place(right.multiplyScalar(s * 1.05).add(EARTH_POS), camera, smooth(0.55, 0.75, q) * (1 - smooth(0.86, 0.9, p)), view);

      earth.satLocal.forEach((local, i) => {
        world.copy(local).multiplyScalar(s).add(EARTH_POS);
        satTags[i].place(world, camera, earthBlocks(world, s) ? 0 : swarm, view);
      });

      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      toCam.copy(camera.position).sub(EARTH_POS).normalize();
      earth.siteNormals.forEach((n, i) => {
        // Rotate the local normal about Y by theta to get its world direction.
        normal.set(n.x * cosT + n.z * sinT, n.y, -n.x * sinT + n.z * cosT);
        const facing = smooth(0.0, 0.15, normal.dot(toCam));
        world.copy(normal).multiplyScalar(s * 1.003).add(EARTH_POS);
        siteTags[i].place(world, camera, i === focusIdx ? swarm * facing : 0, view);
      });
    },
  };
}

// ---------------------------------------------------------------- entry point

export function createJourney(sites: JourneySite[]): Journey {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const el = document.createElement('div');
  el.className = 'auth-sky';
  const canvas = document.createElement('canvas');
  const labels = document.createElement('div');
  labels.className = 'auth-sky-labels';
  el.append(canvas, labels);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    // No WebGL: hand back an inert layer so the login screen still works.
    return { el, setProgress() {}, jumpTo() {}, focusSite() {}, onFrame: null, dispose() { el.remove(); } };
  }
  renderer.setClearColor(0x02040a, 1);
  renderer.autoClear = false;

  let disposed = false;
  const bin = new Bin();
  const loader = new THREE.TextureLoader();
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const view: View = { w: 1, h: 1, aspect: 1, fx: 0.5, fy: 0.5, dFinal: 4 };
  const uPx = { value: 1 };
  // Big textures and the star catalogue wait until the visitor scrolls toward the scenes that
  // use them (or the browser is idle), so the first screen costs almost nothing to load.
  const deferred: (() => void)[] = [];
  let released = false;
  const defer = (fn: () => void): void => {
    if (released) fn();
    else deferred.push(fn);
  };
  const release = (): void => {
    if (released) return;
    released = true;
    for (const fn of deferred.splice(0)) fn();
  };

  const ctx: Ctx = {
    bin, uPx, view, labels,
    dot: bin.add(dotTexture()),
    isDisposed: () => disposed,
    defer,
    loadTex(name, srgb, onLoad) {
      defer(() => {
        loader.load(`${ASSETS}${name}`, (t) => {
          if (disposed) { t.dispose(); return; }
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = maxAniso;
          bin.add(t);
          onLoad(t);
        }, undefined, () => { /* keep the flat fallback colour */ });
      });
    },
  };

  const sky = buildSky(ctx);
  const galaxy = buildGalaxy(ctx);
  const flight = buildFlight(ctx);
  const solar = buildSolar(ctx, sites);
  const cameras = [sky.camera, galaxy.camera, flight.camera, solar.camera];

  // Final framing: Earth centre and radius in px, shifted while a mission brief is open (wide only).
  let wide = true;
  let shift = 0;
  function applyFraming(k: number): void {
    const { w, h } = view;
    const rBase = wide ? Math.min(0.27 * h, 0.22 * w) : Math.min(0.17 * h, 0.38 * w);
    const rAlt = Math.min(0.22 * h, 0.18 * w);
    const rpx = lerp(rBase, rAlt, k);
    view.fx = wide ? lerp(0.42, 0.47, k) : 0.5;
    view.fy = wide ? lerp(0.5, 0.34, k) : 0.22;
    view.dFinal = 1 / Math.sin(Math.atan((rpx / (h / 2)) * Math.tan(20 * DEG)));
  }

  function layout(): void {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const px = Math.min(window.devicePixelRatio || 1, 2);
    uPx.value = px;
    renderer.setPixelRatio(px);
    renderer.setSize(w, h, false);
    wide = w >= 900;
    Object.assign(view, { w, h, aspect: w / h });
    applyFraming(shift);
    for (const c of cameras) { c.aspect = view.aspect; c.updateProjectionMatrix(); }
  }
  layout();
  window.addEventListener('resize', layout);

  // Earth orientation and focus state.
  const focus: FocusState = { amt: sites.map(() => 0) };
  let focusIdx = -1;
  let targetLon = DEFAULT_LON;
  let focusSince = 0;
  let theta: number | null = null;
  const thetaFor = (lon: number) => -lon - Math.atan2(CAM_DIR_FINAL.z, CAM_DIR_FINAL.x);

  let target = 0, cur = 0, t = 0;
  let last = performance.now();
  let raf = 0;
  let lastRenderMs = 0;

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += reducedMotion ? 0 : dt;
    if (reducedMotion) cur = target;
    else cur += (target - cur) * (1 - Math.exp(-dt * 5));
    if (Math.abs(target - cur) < 1e-5) cur = target;
    const p = cur;
    if (!released && p > 0.03) release();

    const want = thetaFor(targetLon);
    if (theta === null) theta = want;
    else {
      const delta = ((((want - theta + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
      theta += delta * (1 - Math.exp(-dt * 3));
    }
    const wantShift = wide && focusIdx >= 0 && t - focusSince > 0.6 ? 1 : 0;
    shift += (wantShift - shift) * (1 - Math.exp(-dt * 3));
    applyFraming(shift);
    focus.amt.forEach((v, i) => { focus.amt[i] = v + ((i === focusIdx ? 1 : 0) - v) * (1 - Math.exp(-dt * 6)); });

    const skyOp = smooth(0.24, 0.4, p);
    const galOp = 1 - smooth(0.2, 0.3, p);
    const flyOp = smooth(0.22, 0.3, p) * (1 - smooth(0.42, 0.5, p));

    solar.update(p, t, theta, focus, focusIdx);
    galaxy.update(p, t, galOp);
    flight.update(p, flyOp);

    // Sign-in form up (p > 0.95): the scene is static, so draw at about 30 fps. onFrame still runs every frame.
    const draw = p <= 0.95 || now - lastRenderMs >= 33;
    if (draw) {
      lastRenderMs = now;
      renderer.clear();
      if (skyOp > 0.003) {
        sky.camera.quaternion.copy(solar.camera.quaternion);
        sky.setOpacity(skyOp);
        renderer.render(sky.scene, sky.camera);
      }
      if (galOp > 0.003) renderer.render(galaxy.scene, galaxy.camera);
      if (flyOp > 0.003) renderer.render(flight.scene, flight.camera);
      if (p > 0.4) {
        renderer.clearDepth();
        renderer.render(solar.scene, solar.camera);
      }
    }
    api.onFrame?.(p);
  }
  raf = requestAnimationFrame(frame);

  // Fallback so the deferred loads start even if the visitor never scrolls: wait a few seconds
  // (the sign-in card and app code load first), then use the next idle moment.
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  let idleId = 0;
  const idleTimer = window.setTimeout(() => {
    if (idle) idleId = idle.call(window, release, { timeout: 3000 });
    else release();
  }, 4000);

  const api: Journey = {
    el,
    setProgress(p) { target = clamp01(p); },
    jumpTo(p) { target = cur = clamp01(p); },
    focusSite(id) {
      const idx = id === null ? -1 : sites.findIndex((s) => s.id === id);
      if (idx !== focusIdx) focusSince = t;
      focusIdx = idx;
      targetLon = focusIdx >= 0 ? sites[focusIdx].lonDeg * DEG : DEFAULT_LON;
    },
    onFrame: null,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(idleTimer);
      if (idle && idleId) (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idleId);
      window.removeEventListener('resize', layout);
      bin.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
    },
  };
  return api;
}
