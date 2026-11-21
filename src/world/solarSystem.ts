// Solar system scene: Earth, Sun, planets, Moon, stars and orbit lines.
//
// FLOATING ORIGIN: update(jd, origin) places every object at (bodyPos - origin), with bodyPos
// computed in float64. The group itself stays at identity; stars stay at group-local 0.
//
// Sprite scale (sizeAttenuation false): three.js keeps a sprite at a constant fraction of the
// view height, so the constants below are calibrated for a ~50 degree vertical FOV on a
// ~1000 px tall viewport. Tune DOT_SCALE / LABEL_SCALE_Y in the renderer if sizes look off.
//
// Lighting: this module owns the Sun DirectionalLight ('SunLight') and the AmbientLight.
// Lambert materials are used throughout (metalness renders black without an environment map).
//
// Real imagery: in a browser the scene starts with flat colours and random stars, then swaps in
// the files under public/assets/space as they arrive (NASA-derived planet maps, the d3-celestial
// star catalogue, Milky Way contours and constellation lines). A missing file keeps its fallback.
// Nothing is fetched in node or under test.

import * as THREE from 'three';
import { R_EARTH, type Vec3 } from '../types';
import {
  BODIES,
  bodyPositionEarthCentred,
  eclipticToWorld,
  heliocentricOrbitSamples,
  moonGeocentricPosition,
  type BodyDef,
} from './ephemeris';
import {
  PAD_LAT_DEG,
  PAD_LON_DEG,
  buildConstellationSegments,
  buildStarBuffers,
  eclipticNorthWorld,
  equatorialToWorld,
  siteAlignment,
} from './skyData';

const DOT_SCALE = 0.0035; // ~4 px dot
const LABEL_SCALE_Y = 0.017; // ~14 px text on a 1000 px viewport
const LABEL_SCALE_X = LABEL_SCALE_Y * 4; // canvas is 4:1
const LABEL_MIN_RATIO = 20; // hide a label while the camera is closer than 20 body radii
const NEAR_GROUND_HIDE_M = 50_000; // hide all dots and labels below this altitude
const ORBIT_SAMPLES = 256;
const ORBIT_OPACITY = 0.5;
const MOON_PERIOD_DAYS = 27.321661;
const MOON_ORBIT_REFRESH_DAYS = 1;
const STAR_COUNT = 2600;
const BRIGHT_STAR_COUNT = 400;
const STAR_RADIUS = 1e12;
const EARTH_FALLBACK = 0x2f6fb5;
const ASSET_DIR = 'assets/space/';
const CLOUD_ALTITUDE = 12_000;
const CLOUD_PERIOD_DAYS = 12; // one drift of the cloud layer around the globe

/** Texture file and axial tilt (degrees from the ecliptic normal) per body. */
const BODY_LOOK: Record<string, { map: string; tiltDeg: number }> = {
  Mercury: { map: 'mercurymap.jpg', tiltDeg: 0 },
  Venus: { map: 'venusmap.jpg', tiltDeg: 177.4 },
  Mars: { map: 'marsmap1k.jpg', tiltDeg: 25.2 },
  Jupiter: { map: 'jupitermap.jpg', tiltDeg: 3.1 },
  Saturn: { map: 'saturnmap.jpg', tiltDeg: 26.7 },
  Uranus: { map: 'uranusmap.jpg', tiltDeg: 97.8 },
  Neptune: { map: 'neptunemap.jpg', tiltDeg: 28.3 },
  Moon: { map: 'moonmap1k.jpg', tiltDeg: 0 },
};

// Shader chunks so custom materials write the same logarithmic depth as the built-in ones.
const LOG = {
  vp: '#include <common>\n#include <logdepthbuf_pars_vertex>',
  v: '#include <logdepthbuf_vertex>',
  fp: '#include <common>\n#include <logdepthbuf_pars_fragment>',
  f: '#include <logdepthbuf_fragment>',
};

export interface SolarSystem {
  group: THREE.Group;
  /**
   * Position every body for the given epoch and floating origin.
   * cameraWorldPos is the camera relative to origin (scene metres). Undefined means the camera
   * sits at the origin. It hides dots and labels below 50 km altitude and hides a body's label
   * while the camera is closer than 20 body radii.
   */
  update(jd: number, origin: Vec3, cameraWorldPos?: THREE.Vector3): void;
  /** Unit vector from the origin toward the Sun. */
  sunDirection: THREE.Vector3;
  /** Show or hide the constellation stick figures. Returns the new state. */
  setConstellations(on: boolean): boolean;
}

// ---------- asset loading ----------

function assetsEnabled(): boolean {
  const env = (import.meta as { env?: { MODE?: string } }).env;
  return typeof document !== 'undefined' && typeof fetch === 'function' && env?.MODE !== 'test';
}

function assetUrl(file: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  return `${base}${ASSET_DIR}${file}`;
}

let textureLoader: THREE.TextureLoader | null = null;

/** Loads a texture in the background. Does nothing without a browser or when the file is missing. */
function loadTexture(file: string, onLoad: (t: THREE.Texture) => void, srgb = true): void {
  if (!assetsEnabled()) return;
  textureLoader ??= new THREE.TextureLoader();
  textureLoader.load(
    assetUrl(file),
    (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      onLoad(t);
    },
    undefined,
    () => {},
  );
}

function loadJson(file: string, onLoad: (data: unknown) => void): void {
  if (!assetsEnabled()) return;
  fetch(assetUrl(file))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j) onLoad(j);
    })
    .catch(() => {});
}

/**
 * Rasterises the Milky Way brightness contours (RA/Dec polygons, one feature per level) into an
 * equirectangular texture. Null without a 2D canvas.
 */
function makeMilkyWayTexture(mw: unknown): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  type Ring = number[][];
  const features = (mw as { features?: { geometry: { type: string; coordinates: unknown } }[] }).features ?? [];
  features.forEach((f, level) => {
    ctx.filter = `blur(${Math.max(4, 17 - level * 3)}px)`;
    const polys = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]) as Ring[][];
    for (const poly of polys) {
      for (const dx of [-W, 0, W]) {
        ctx.beginPath();
        for (const ring of poly) {
          let prev: number | null = null;
          let off = 0;
          ring.forEach(([lon, lat], k) => {
            const ra = lon < 0 ? lon + 360 : lon;
            if (prev !== null) {
              if (ra - prev > 180) off -= 360;
              else if (prev - ra > 180) off += 360;
            }
            prev = ra;
            const x = ((ra + off) / 360) * W + dx;
            const y = (0.5 - lat / 180) * H;
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fillStyle = 'rgb(40,38,50)';
        ctx.fill('evenodd');
      }
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Additive limb glow for the Earth: a thin rim over the disc (front) or a halo behind it (back). */
function makeRimMaterial(
  back: boolean,
  sunView: { value: THREE.Vector3 },
  opacity: { value: number },
  intensity: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSunView: sunView, uOpacity: opacity, uInt: { value: intensity } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: back ? THREE.BackSide : THREE.FrontSide,
    vertexShader: `${LOG.vp}
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        ${LOG.v}
      }`,
    fragmentShader: `${LOG.fp}
      uniform vec3 uSunView; uniform float uOpacity; uniform float uInt;
      varying vec3 vN; varying vec3 vV;
      void main() {
        ${LOG.f}
        float d = dot(normalize(vN), normalize(vV));
        float rim = ${back ? 'pow(clamp(-d, 0.0, 1.0), 5.2)' : 'pow(clamp(1.0 - d, 0.0, 1.0), 4.0)'};
        float sun = smoothstep(-0.35, 0.55, dot(normalize(vN), uSunView));
        vec3 c = mix(vec3(0.10, 0.32, 0.95), vec3(0.45, 0.7, 1.0), rim) * (0.25 + 0.75 * sun) * rim * uInt;
        gl_FragColor = vec4(c * uOpacity, 1.0);
      }`,
  });
}

// ---------- small helpers ----------

function hash3(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  return lerp(
    lerp(lerp(c000, c100, u), lerp(c010, c110, u), v),
    lerp(lerp(c001, c101, u), lerp(c011, c111, u), v),
    w,
  );
}

function fbm(x: number, y: number, z: number): number {
  return (
    0.55 * valueNoise3(x, y, z) +
    0.3 * valueNoise3(x * 2.03, y * 2.03, z * 2.03) +
    0.15 * valueNoise3(x * 4.1, y * 4.1, z * 4.1)
  );
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Flat stylised Earth: ocean, land, sand fringes and polar ice from low-frequency value noise.
 * The +Y pole (under the launch site) is always land so it matches the ground disc.
 * Returns null without a DOM; the caller then uses a plain ocean colour.
 */
function makeEarthTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);
  const ocean = [0x2f, 0x6f, 0xb5];
  const land = [0x5f, 0xa0, 0x52];
  const sand = [0xd9, 0xc4, 0x8a];
  const ice = [0xf4, 0xf8, 0xfb];
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  for (let y = 0; y < H; y++) {
    const lat = Math.PI * (0.5 - (y + 0.5) / H); // row 0 is the +Y pole (canvas flipY)
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = (2 * Math.PI * (x + 0.5)) / W;
      const n = fbm(cl * Math.cos(lon) * 2.2 + 11.3, sl * 2.2 + 4.1, cl * Math.sin(lon) * 2.2 - 7.7);
      const northCap = smoothstep(1.05, 1.2, lat); // launch-site pole: land only
      const landT = Math.max(northCap, smoothstep(0.5, 0.53, n));
      const sandT = (smoothstep(0.5, 0.52, n) - smoothstep(0.55, 0.57, n)) * (1 - northCap) * 0.9;
      const iceT = smoothstep(-1.12, -1.3, lat + (n - 0.5) * 0.25);
      let c = mix(ocean, land, landT);
      c = mix(c, sand, sandT);
      c = mix(c, ice, iceT);
      const i = (y * W + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft radial dot texture. Pure data, so it works without a DOM. */
function makeRadialTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, Math.min(1, 1 - r));
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/** White name label texture (70 % opacity). Null when no DOM is available (node tests). */
function makeLabelTexture(text: string): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = 'bold 46px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(text, 24, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeLabel(name: string): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeLabelTexture(name),
      color: 0xffffff,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
    }),
  );
  sprite.center.set(0, 0.5);
  sprite.scale.set(LABEL_SCALE_X, LABEL_SCALE_Y, 1);
  sprite.name = `${name}Label`;
  return sprite;
}

function makeDot(color: number, dotTex: THREE.Texture, name: string): THREE.Sprite {
  const dot = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: dotTex,
      color,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
    }),
  );
  dot.scale.set(DOT_SCALE, DOT_SCALE, 1);
  dot.name = name;
  return dot;
}

function makeOrbitLine(name: string, color: number, positions: Float32Array): THREE.Line {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: ORBIT_OPACITY,
      depthWrite: false,
    }),
  );
  line.name = `${name}Orbit`;
  line.frustumCulled = false;
  return line;
}

/**
 * Random star directions on a huge sphere with per-vertex brightness and a slight colour tint.
 * Sizes are uniform because they come from the shared PointsMaterial.
 */
function starGeometry(count: number, minBrightness: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = 2 * Math.random() - 1;
    const phi = 2 * Math.PI * Math.random();
    const s = Math.sqrt(1 - z * z);
    pos[i * 3] = STAR_RADIUS * s * Math.cos(phi);
    pos[i * 3 + 1] = STAR_RADIUS * z;
    pos[i * 3 + 2] = STAR_RADIUS * s * Math.sin(phi);

    const b = minBrightness + (1 - minBrightness) * Math.random();
    const tint = Math.random();
    let r = b, g = b, bl = b;
    if (tint < 0.15) {
      r = b * 0.8; g = b * 0.9; // bluish
    } else if (tint > 0.9) {
      g = b * 0.92; bl = b * 0.75; // warm
    }
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = bl;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---------- scene ----------

interface BodyEntry {
  def: BodyDef;
  mesh: THREE.Mesh;
  dot: THREE.Sprite;
  label: THREE.Sprite;
  orbit: THREE.Line;
  orbitPositions: Float32Array;
  /** Moon-style orbit: geocentric, rebuilt only every MOON_ORBIT_REFRESH_DAYS. */
  geocentric: boolean;
  lastGeocentricJd: number;
}

export function buildSolarSystem(): SolarSystem {
  const group = new THREE.Group();
  group.name = 'solarSystem';
  const sunDirection = new THREE.Vector3(1, 0, 0);
  const dotTex = makeRadialTexture();

  // Earth. Sunk 2 km so the faceted 128x64 tessellation sits below the local ground disc.
  const earthTex = makeEarthTexture();
  // Phong with a black specular colour shades exactly like Lambert until the real maps arrive.
  const earthMat = new THREE.MeshPhongMaterial({
    map: earthTex,
    color: earthTex ? 0xffffff : EARTH_FALLBACK,
    specular: 0x000000,
    shininess: 22,
  });
  // City lights only on the night side: the emissive map is masked by the Sun direction.
  const sunView = { value: new THREE.Vector3(1, 0, 0) };
  earthMat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirView = sunView;
    shader.fragmentShader =
      'uniform vec3 uSunDirView;\n' +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#ifdef USE_EMISSIVEMAP
          vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
          float nightF = smoothstep( 0.02, -0.22, dot( normalize( vNormal ), uSunDirView ) );
          totalEmissiveRadiance *= emissiveColor.rgb * nightF;
        #endif`,
      );
  };
  const earth = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH - 2000, 128, 64), earthMat);
  earth.name = 'Earth';
  earth.onBeforeRender = (_r, _s, camera) => {
    sunView.value.copy(sunDirection).transformDirection(camera.matrixWorldInverse);
  };

  // Real Earth: turn the globe so Sriharikota sits under the pad, then add relief, ocean glint,
  // night lights and clouds. The stylised texture stays if the day map cannot be loaded.
  let clouds: THREE.Mesh | null = null;
  loadTexture('earth_atmos_2048.jpg', (day) => {
    const [mx, my, mz] = siteAlignment(PAD_LAT_DEG, PAD_LON_DEG);
    earth.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().set(
        mx[0], mx[1], mx[2], 0,
        my[0], my[1], my[2], 0,
        mz[0], mz[1], mz[2], 0,
        0, 0, 0, 1,
      ),
    );
    earthMat.map = day;
    earthMat.color.set(0xffffff);
    earthMat.needsUpdate = true;
    earthTex?.dispose();
    loadTexture('earth_specular_2048.jpg', (t) => {
      earthMat.specularMap = t;
      earthMat.specular.set(0x3a3a3a);
      earthMat.needsUpdate = true;
    }, false);
    loadTexture('earth_normal_2048.jpg', (t) => {
      earthMat.normalMap = t;
      earthMat.normalScale.set(0.9, 0.9);
      earthMat.needsUpdate = true;
    }, false);
    loadTexture('earth_lights_2048.png', (t) => {
      earthMat.emissiveMap = t;
      earthMat.emissive.setRGB(1.0, 0.82, 0.55);
      earthMat.emissiveIntensity = 1.4;
      earthMat.needsUpdate = true;
    });
    loadTexture('earth_clouds_1024.png', (t) => {
      clouds = new THREE.Mesh(
        new THREE.SphereGeometry(R_EARTH + CLOUD_ALTITUDE, 96, 48),
        new THREE.MeshLambertMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0 }),
      );
      clouds.name = 'Clouds';
      clouds.visible = false;
      earth.add(clouds);
    });
  });
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH + 80_000, 96, 48),
    new THREE.MeshBasicMaterial({
      color: 0x9ed4ff,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }),
  );
  atmosphere.name = 'Atmosphere';
  earth.add(atmosphere);
  // Limb glow seen from space. It fades in with altitude while the flat shell above fades out.
  const rimOpacity = { value: 0 };
  const rimFront = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH + 70_000, 96, 48),
    makeRimMaterial(false, sunView, rimOpacity, 1.5),
  );
  rimFront.name = 'AtmosphereRim';
  const rimBack = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH + 150_000, 96, 48),
    makeRimMaterial(true, sunView, rimOpacity, 1.8),
  );
  rimBack.name = 'AtmosphereHalo';
  rimFront.visible = rimBack.visible = false;
  earth.add(rimFront, rimBack);
  group.add(earth);

  // Sun: emissive sphere, glow sprite, label, and the light that follows sunDirection.
  const sunDef = BODIES.find((b) => b.name === 'Sun')!;
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(sunDef.radius, 48, 24),
    new THREE.MeshBasicMaterial({ color: sunDef.color }),
  );
  sun.name = 'Sun';
  group.add(sun);
  loadTexture('sunmap.jpg', (t) => {
    const m = sun.material as THREE.MeshBasicMaterial;
    m.map = t;
    m.color.set(0xffffff);
    m.needsUpdate = true;
  });
  const sunGlow = makeDot(0xffd27a, dotTex, 'SunGlow');
  sunGlow.scale.set(0.12, 0.12, 1);
  sunGlow.material.blending = THREE.AdditiveBlending;
  group.add(sunGlow);
  const sunLabel = makeLabel('Sun');
  group.add(sunLabel);

  const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sunLight.name = 'SunLight';
  group.add(sunLight);
  group.add(sunLight.target); // target sits at the origin, so the light points at the pad
  const ambient = new THREE.AmbientLight(0xdfeaff, 0.9);
  ambient.name = 'Ambient';
  group.add(ambient);

  // Stars: main field plus a brighter child sharing the same material, so fading
  // 'Stars'.material.opacity fades both.
  const starMaterial = new THREE.PointsMaterial({
    vertexColors: true,
    size: 1.5,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeometry(STAR_COUNT, 0.5), starMaterial);
  stars.name = 'Stars';
  stars.frustumCulled = false;
  const brightStars = new THREE.Points(starGeometry(BRIGHT_STAR_COUNT, 0.85), starMaterial);
  brightStars.name = 'StarsBright';
  brightStars.frustumCulled = false;
  stars.add(brightStars);
  group.add(stars);

  // Real sky. Everything hangs under 'Stars', so hiding or fading that object fades the lot;
  // update() copies the shared star opacity onto the extra materials.
  const brightMaterial = new THREE.PointsMaterial({
    vertexColors: true,
    size: 4.5,
    map: dotTex,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
  });
  const skyOpacity = { value: 1 };
  let constellations: THREE.LineSegments | null = null;
  let constellationsOn = false;
  const setPoints = (points: THREE.Points, positions: Float32Array, colors: Float32Array): void => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    points.geometry.dispose();
    points.geometry = geo;
  };
  loadJson('stars.6.json', (data) => {
    const { faint, bright } = buildStarBuffers(data as Parameters<typeof buildStarBuffers>[0], STAR_RADIUS);
    if (faint.count + bright.count < 100) return; // not a usable catalogue: keep the random field
    setPoints(stars, faint.positions, faint.colors);
    setPoints(brightStars, bright.positions, bright.colors);
    brightStars.material = brightMaterial;
  });
  loadJson('mw.json', (data) => {
    const tex = makeMilkyWayTexture(data);
    if (!tex) return;
    // Rows are the world-frame images of the equatorial axes, i.e. the world -> equatorial rotation.
    const ex = equatorialToWorld([1, 0, 0]), ey = equatorialToWorld([0, 1, 0]), ez = equatorialToWorld([0, 0, 1]);
    const milkyWay = new THREE.Mesh(
      new THREE.SphereGeometry(STAR_RADIUS * 0.9, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: tex },
          uOpacity: skyOpacity,
          uToEq: { value: new THREE.Matrix3().set(ex[0], ex[1], ex[2], ey[0], ey[1], ey[2], ez[0], ez[1], ez[2]) },
        },
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `${LOG.vp}
          varying vec3 vP;
          void main() {
            vP = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            ${LOG.v}
          }`,
        fragmentShader: `${LOG.fp}
          uniform sampler2D uTex; uniform mat3 uToEq; uniform float uOpacity; varying vec3 vP;
          float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          void main() {
            ${LOG.f}
            vec3 e = uToEq * normalize(vP);
            float ra = atan(e.y, e.x); if (ra < 0.0) ra += 6.2831853;
            float dec = asin(clamp(e.z, -1.0, 1.0));
            vec2 uv = vec2(ra / 6.2831853, 0.5 + dec / 3.14159265);
            float m = texture2D(uTex, uv).r;
            float grain = 0.9 + 0.2 * h(floor(uv * vec2(3600.0, 1800.0)));
            gl_FragColor = vec4(vec3(0.56, 0.62, 0.86) * m * 0.55 * grain * uOpacity, 1.0);
          }`,
      }),
    );
    milkyWay.name = 'MilkyWay';
    milkyWay.frustumCulled = false;
    milkyWay.renderOrder = -1;
    stars.add(milkyWay);
  });
  loadJson('constellations.lines.json', (data) => {
    const seg = buildConstellationSegments(data as Parameters<typeof buildConstellationSegments>[0], STAR_RADIUS * 0.95);
    if (seg.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seg, 3));
    constellations = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x4a78d8, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    constellations.name = 'Constellations';
    constellations.frustumCulled = false;
    constellations.visible = constellationsOn;
    stars.add(constellations);
  });
  const setConstellations = (on: boolean): boolean => {
    constellationsOn = on;
    if (constellations) constellations.visible = on;
    return on;
  };

  // Bodies: Earth, planets and Moon. Each gets a mesh, a dot, a label and an orbit line.
  const bodies: BodyEntry[] = [];
  for (const def of BODIES) {
    if (def.name === 'Sun') continue;
    let mesh: THREE.Mesh;
    if (def.name === 'Earth') {
      mesh = earth;
    } else {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(def.radius, 32, 16),
        new THREE.MeshLambertMaterial({ color: def.color }),
      );
      mesh.name = def.name;
      group.add(mesh);

      const look = BODY_LOOK[def.name];
      if (look) {
        const mat = mesh.material as THREE.MeshLambertMaterial;
        loadTexture(look.map, (t) => {
          mat.map = t;
          mat.color.set(0xffffff);
          mat.needsUpdate = true;
        });
        // Spin axis: the ecliptic normal tipped by the body's axial tilt.
        const tilt = (look.tiltDeg * Math.PI) / 180;
        const axis = eclipticToWorld([Math.sin(tilt), 0, Math.cos(tilt)]);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...axis).normalize());
      }
      if (def.name === 'Moon') {
        loadTexture('moonbump1k.jpg', (t) => {
          const mat = mesh.material as THREE.MeshLambertMaterial;
          mat.bumpMap = t;
          mat.bumpScale = 1.6;
          mat.needsUpdate = true;
        }, false);
      }
      if (def.name === 'Saturn') {
        const inner = def.radius * 1.25, outer = def.radius * 2.35;
        const ringGeo = new THREE.RingGeometry(inner, outer, 128, 1);
        const p = ringGeo.attributes.position, uv = ringGeo.attributes.uv;
        for (let k = 0; k < p.count; k++) {
          uv.setXY(k, (Math.hypot(p.getX(k), p.getY(k)) - inner) / (outer - inner), 0.5);
        }
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xd8c9a0,
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          opacity: 0.55,
        });
        loadTexture('saturnringcolor.jpg', (t) => {
          ringMat.map = t;
          ringMat.color.setScalar(0.85);
          ringMat.opacity = 0.95;
          ringMat.needsUpdate = true;
        });
        loadTexture('saturnringpattern.gif', (t) => {
          ringMat.alphaMap = t;
          ringMat.needsUpdate = true;
        }, false);
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.name = 'SaturnRing';
        ring.rotation.x = Math.PI / 2; // into the equatorial plane
        mesh.add(ring);
      }
    }

    const dot = makeDot(def.color, dotTex, `${def.name}Dot`);
    group.add(dot);
    const label = makeLabel(def.name);
    group.add(label);

    const orbitPositions = new Float32Array((ORBIT_SAMPLES + 1) * 3);
    const geocentric = def.parent === 'earth';
    const orbit = makeOrbitLine(def.name, def.color, orbitPositions);
    group.add(orbit);

    bodies.push({
      def,
      mesh,
      dot,
      label,
      orbit,
      orbitPositions,
      geocentric,
      lastGeocentricJd: Number.NaN,
    });
  }

  const sunRel: Vec3 = [0, 0, 0];
  const eclipticNorth = new THREE.Vector3(...eclipticNorthWorld());
  const moonX = new THREE.Vector3(), moonY = new THREE.Vector3(), moonZ = new THREE.Vector3();
  const moonBasis = new THREE.Matrix4();

  /** Fills the Moon orbit (Earth-centred, closed loop over one sidereal month). */
  function fillGeocentricOrbit(jd: number, arr: Float32Array): void {
    for (let k = 0; k < ORBIT_SAMPLES; k++) {
      const t = jd + (k / ORBIT_SAMPLES) * MOON_PERIOD_DAYS;
      const w = eclipticToWorld(moonGeocentricPosition(t));
      arr[k * 3] = w[0];
      arr[k * 3 + 1] = w[1];
      arr[k * 3 + 2] = w[2];
    }
    arr[ORBIT_SAMPLES * 3] = arr[0];
    arr[ORBIT_SAMPLES * 3 + 1] = arr[1];
    arr[ORBIT_SAMPLES * 3 + 2] = arr[2];
  }

  /** Fills a heliocentric orbit. Vertices are relative to the Sun. */
  function fillHeliocentricOrbit(name: string, jd: number, arr: Float32Array): void {
    const samples = heliocentricOrbitSamples(name, jd, ORBIT_SAMPLES);
    for (let k = 0; k <= ORBIT_SAMPLES; k++) {
      const s = samples[k % ORBIT_SAMPLES];
      const w = eclipticToWorld(s);
      arr[k * 3] = w[0];
      arr[k * 3 + 1] = w[1];
      arr[k * 3 + 2] = w[2];
    }
  }

  function update(jd: number, origin: Vec3, cameraWorldPos?: THREE.Vector3): void {
    const [ox, oy, oz] = origin;

    // Camera in Earth-centred world metres. Undefined cameraWorldPos means the camera is at the origin.
    const camX = ox + (cameraWorldPos?.x ?? 0);
    const camY = oy + (cameraWorldPos?.y ?? 0);
    const camZ = oz + (cameraWorldPos?.z ?? 0);
    const altitude = Math.hypot(camX, camY, camZ) - R_EARTH;
    const nearGround = altitude < NEAR_GROUND_HIDE_M;

    earth.position.set(-ox, -oy, -oz);

    // Space look: limb glow and clouds fade in above the weather, the flat shell fades out.
    const high = smoothstep(120_000, 600_000, altitude);
    rimOpacity.value = high;
    rimFront.visible = rimBack.visible = high > 0.01;
    (atmosphere.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - 0.8 * high);
    if (clouds) {
      const c = smoothstep(30_000, 200_000, altitude);
      (clouds.material as THREE.MeshLambertMaterial).opacity = 0.9 * c;
      clouds.visible = c > 0.01;
      clouds.rotation.y = ((jd % CLOUD_PERIOD_DAYS) / CLOUD_PERIOD_DAYS) * 2 * Math.PI;
    }
    skyOpacity.value = starMaterial.opacity;
    brightMaterial.opacity = starMaterial.opacity;

    // Sun position relative to the origin.
    const sunEC = bodyPositionEarthCentred('Sun', jd);
    sunRel[0] = sunEC[0] - ox;
    sunRel[1] = sunEC[1] - oy;
    sunRel[2] = sunEC[2] - oz;
    sun.position.set(sunRel[0], sunRel[1], sunRel[2]);
    sunGlow.position.set(sunRel[0], sunRel[1], sunRel[2]);
    sunGlow.visible = !nearGround;
    sunLabel.position.set(sunRel[0], sunRel[1], sunRel[2]);
    sunLabel.visible =
      !nearGround &&
      Math.hypot(camX - sunEC[0], camY - sunEC[1], camZ - sunEC[2]) >= LABEL_MIN_RATIO * sunDef.radius;
    const len = Math.hypot(sunRel[0], sunRel[1], sunRel[2]);
    if (len > 0) sunDirection.set(sunRel[0] / len, sunRel[1] / len, sunRel[2] / len);
    sunLight.position.copy(sunDirection);

    for (const b of bodies) {
      const pos = bodyPositionEarthCentred(b.def.name, jd);
      const rx = pos[0] - ox, ry = pos[1] - oy, rz = pos[2] - oz;
      b.mesh.position.set(rx, ry, rz);
      if (b.def.name === 'Moon') {
        // Tidally locked: the map's prime meridian (mesh +X) faces Earth, north along the ecliptic normal.
        moonX.set(-pos[0], -pos[1], -pos[2]).normalize();
        moonY.copy(eclipticNorth).addScaledVector(moonX, -eclipticNorth.dot(moonX)).normalize();
        moonZ.crossVectors(moonX, moonY);
        b.mesh.quaternion.setFromRotationMatrix(moonBasis.makeBasis(moonX, moonY, moonZ));
      }
      b.dot.position.set(rx, ry, rz);
      b.label.position.set(rx, ry, rz);

      b.dot.visible = !nearGround;
      const dist = Math.hypot(camX - pos[0], camY - pos[1], camZ - pos[2]);
      b.label.visible = !nearGround && dist >= LABEL_MIN_RATIO * b.def.radius;

      if (b.geocentric) {
        if (
          Number.isNaN(b.lastGeocentricJd) ||
          Math.abs(jd - b.lastGeocentricJd) > MOON_ORBIT_REFRESH_DAYS
        ) {
          fillGeocentricOrbit(jd, b.orbitPositions);
          b.lastGeocentricJd = jd;
          (b.orbit.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        }
        b.orbit.position.set(-ox, -oy, -oz); // centred on Earth
      } else {
        fillHeliocentricOrbit(b.def.name, jd, b.orbitPositions);
        (b.orbit.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        b.orbit.position.set(sunRel[0], sunRel[1], sunRel[2]); // centred on the Sun
      }
    }
  }

  return { group, update, sunDirection, setConstellations };
}
