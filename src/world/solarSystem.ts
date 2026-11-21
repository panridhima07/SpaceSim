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
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH - 2000, 128, 64),
    new THREE.MeshLambertMaterial({
      map: earthTex,
      color: earthTex ? 0xffffff : EARTH_FALLBACK,
    }),
  );
  earth.name = 'Earth';
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
  group.add(earth);

  // Sun: emissive sphere, glow sprite, label, and the light that follows sunDirection.
  const sunDef = BODIES.find((b) => b.name === 'Sun')!;
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(sunDef.radius, 48, 24),
    new THREE.MeshBasicMaterial({ color: sunDef.color }),
  );
  sun.name = 'Sun';
  group.add(sun);
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

  return { group, update, sunDirection };
}
