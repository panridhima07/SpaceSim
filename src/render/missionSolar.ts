// Sun, planets, Moon, their orbits and labels for the mission view, placed in the mission's own
// inertial frame (Earth-centred, app Y-up: Y = Earth's north pole, see mission/adapter.ts) at the
// flight's real date. Add `group` under the Earth-centred world group; positions are metres from
// Earth's centre.
//
// The physics uses J2000-ish equatorial ECI with the Earth angle taken from GMST at the epoch, so
// ecliptic positions from world/ephemeris.ts map in through the obliquity rotation plus eciToApp.

import * as THREE from 'three';
import type { Vec3 } from '../types';
import { BODIES, heliocentricOrbitSamples, heliocentricPosition, moonGeocentricPosition } from '../world/ephemeris';
import { loadSharedTexture } from './textureCache';

const OBL = (23.4392911 * Math.PI) / 180;
const CO = Math.cos(OBL);
const SO = Math.sin(OBL);
const ORBIT_SAMPLES = 360;
const MOON_PERIOD_DAYS = 27.321661;
/** Planet orbits change negligibly over days, so they are refilled only every this many days. */
const PLANET_ORBIT_REFRESH_DAYS = 10;
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** J2000 ecliptic vector to the mission app frame. */
export function eclipticToApp(v: Vec3): Vec3 {
  const yEq = v[1] * CO - v[2] * SO;
  const zEq = v[1] * SO + v[2] * CO;
  return [v[0], zEq, -yEq];
}

/** Unit vector toward the Sun from Earth's centre, app frame, at a Julian date. */
export function sunDirectionApp(jd: number): THREE.Vector3 {
  const e = heliocentricPosition('Earth', jd);
  const a = eclipticToApp([-e[0], -e[1], -e[2]]);
  return new THREE.Vector3(a[0], a[1], a[2]).normalize();
}

/** Ecliptic north pole in the app frame. */
export const ECLIPTIC_NORTH_APP = (() => {
  const a = eclipticToApp([0, 0, 1]);
  return new THREE.Vector3(a[0], a[1], a[2]).normalize();
})();

const MAPS: Record<string, string> = {
  Sun: 'sunmap.jpg',
  Mercury: 'mercurymap.jpg',
  Venus: 'venusmap.jpg',
  Mars: 'marsmap1k.jpg',
  Jupiter: 'jupitermap.jpg',
  Saturn: 'saturnmap.jpg',
  Uranus: 'uranusmap.jpg',
  Neptune: 'neptunemap.jpg',
  Moon: 'moonmap1k.jpg',
};

function assetsEnabled(): boolean {
  const env = (import.meta as { env?: { MODE?: string } }).env;
  return typeof document !== 'undefined' && typeof fetch === 'function' && env?.MODE !== 'test';
}

function assetUrl(file: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  return `${base}assets/space/${file}`;
}

function radialTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const a = Math.max(0, 1 - r);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * Math.pow(a, 1.6));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

function labelSprite(text: string, color: string): THREE.Sprite | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = '500 30px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.fillText(text, 26, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  s.center.set(0, 0.5);
  s.scale.set(0.11, 0.0275, 1);
  s.renderOrder = 20;
  return s;
}


/** Shared world-space Sun position for the planet shader (set each update). */
const sunWorldUniform = { value: new THREE.Vector3() };

/**
 * Planets and the Moon are lit by the Sun in their own shader, not by the scene lights: the
 * scene's sunlight dims while the rocket is in Earth's shadow, but the Moon should not.
 */
function planetMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null as THREE.Texture | null },
      uHasMap: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uSunWorld: sunWorldUniform,
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uMap;
      uniform float uHasMap;
      uniform vec3 uColor;
      uniform vec3 uSunWorld;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 base = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : uColor;
        float ndl = dot(normalize(vN), normalize(uSunWorld - vW));
        float lit = smoothstep(-0.05, 0.25, ndl) * (0.25 + 0.75 * max(ndl, 0.0));
        gl_FragColor = vec4(base * (0.025 + 1.9 * lit), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

interface Body {
  name: string;
  radius: number;
  mesh: THREE.Mesh | null;
  dot: THREE.Sprite;
  label: THREE.Sprite | null;
  orbit: THREE.Line | null;
  textured: boolean;
  pos: THREE.Vector3;
}

export interface MissionSolar {
  group: THREE.Group;
  /** Place bodies for jd. camEarth = camera position relative to Earth's centre (app frame, m).
      skyDark (0..1) fades dots and labels in once the sky is black. */
  update(jd: number, camEarth: THREE.Vector3, skyDark: number, earthWorld?: THREE.Vector3): void;
  /** Sun position relative to Earth's centre from the last update, app frame. */
  readonly sunPos: THREE.Vector3;
  dispose(): void;
}

export function buildMissionSolar(): MissionSolar {
  const group = new THREE.Group();
  group.name = 'mission-solar';
  const dotTex = radialTexture();
  const disposables: { dispose(): void }[] = [dotTex];

  const sunDef = BODIES.find((b) => b.name === 'Sun')!;
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9 });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(sunDef.radius, 48, 24), sunMat);
  sun.name = 'mission-sun';
  group.add(sun);
  const sunGlowMat = new THREE.SpriteMaterial({
    map: dotTex,
    color: 0xffd9a0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const sunGlow = new THREE.Sprite(sunGlowMat);
  sunGlow.scale.setScalar(sunDef.radius * 9);
  group.add(sunGlow);
  const sunFlareMat = new THREE.SpriteMaterial({
    map: dotTex,
    color: 0xfff0d0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    sizeAttenuation: false,
  });
  const sunFlare = new THREE.Sprite(sunFlareMat);
  sunFlare.scale.setScalar(0.09);
  sunFlare.renderOrder = 19;
  group.add(sunFlare);
  const sunLabel = labelSprite('Sun', '#ffd27a');
  if (sunLabel) group.add(sunLabel);
  disposables.push(sun.geometry, sunMat, sunGlowMat, sunFlareMat);

  const bodies: Body[] = [];
  for (const def of BODIES) {
    if (def.name === 'Sun') continue;
    const isEarth = def.name === 'Earth';
    let mesh: THREE.Mesh | null = null;
    if (!isEarth) {
      const mat = planetMaterial(def.color);
      mesh = new THREE.Mesh(new THREE.SphereGeometry(def.radius, 48, 24), mat);
      mesh.name = `mission-${def.name}`;
      group.add(mesh);
      disposables.push(mesh.geometry, mat);
      if (def.name === 'Saturn') {
        const inner = def.radius * 1.25, outer = def.radius * 2.35;
        const ringGeo = new THREE.RingGeometry(inner, outer, 96, 1);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xd8c9a0, side: THREE.DoubleSide, transparent: true, opacity: 0.7, depthWrite: false });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        // Ring plane ~ Saturn's equator, tilted 26.7 deg to its orbit.
        ring.rotation.x = Math.PI / 2 - (26.7 * Math.PI) / 180;
        mesh.add(ring);
        disposables.push(ringGeo, ringMat);
      }
    }
    const color = new THREE.Color(def.color);
    const dotMat = new THREE.SpriteMaterial({ map: dotTex, color, depthWrite: false, transparent: true, sizeAttenuation: false });
    const dot = new THREE.Sprite(dotMat);
    dot.scale.setScalar(0.009);
    dot.renderOrder = 18;
    group.add(dot);
    disposables.push(dotMat);
    const label = labelSprite(def.name, `#${color.getHexString()}`);
    if (label) group.add(label);

    let orbit: THREE.Line | null = null;
    if (def.name !== 'Moon') {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SAMPLES + 1) * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
      orbit = new THREE.Line(geo, mat);
      orbit.frustumCulled = false;
      group.add(orbit);
      disposables.push(geo, mat);
    } else {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SAMPLES + 1) * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xaab3c2, transparent: true, opacity: 0, depthWrite: false });
      orbit = new THREE.Line(geo, mat);
      orbit.frustumCulled = false;
      group.add(orbit);
      disposables.push(geo, mat);
    }
    bodies.push({ name: def.name, radius: def.radius, mesh, dot, label, orbit, textured: false, pos: new THREE.Vector3() });
  }

  const sunPos = new THREE.Vector3();
  let planetsJd = NaN;
  let moonJd = NaN;
  let texturesRequested = false;
  const tmp = new THREE.Vector3();

  /** Refill the orbit lines of the planets (heliocentric) or of the Moon (geocentric). */
  function fillOrbits(jd: number, which: 'planets' | 'moon'): void {
    for (const b of bodies) {
      if (!b.orbit) continue;
      const isMoon = b.name === 'Moon';
      if (isMoon !== (which === 'moon')) continue;
      const arr = (b.orbit.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      if (isMoon) {
        for (let k = 0; k <= ORBIT_SAMPLES; k++) {
          const p = eclipticToApp(moonGeocentricPosition(jd + ((k % ORBIT_SAMPLES) / ORBIT_SAMPLES) * MOON_PERIOD_DAYS));
          arr[k * 3] = p[0];
          arr[k * 3 + 1] = p[1];
          arr[k * 3 + 2] = p[2];
        }
      } else {
        const pts = heliocentricOrbitSamples(b.name === 'Earth' ? 'Earth' : b.name, jd, ORBIT_SAMPLES);
        for (let k = 0; k <= ORBIT_SAMPLES; k++) {
          const q = pts[k % ORBIT_SAMPLES];
          // Relative to the Sun; the line object is moved to the Sun's position each frame.
          const p = eclipticToApp(q);
          arr[k * 3] = p[0];
          arr[k * 3 + 1] = p[1];
          arr[k * 3 + 2] = p[2];
        }
      }
      (b.orbit.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      b.orbit.geometry.computeBoundingSphere();
    }
  }

  function requestTextures(): void {
    if (texturesRequested || !assetsEnabled()) return;
    texturesRequested = true;
    loadSharedTexture(assetUrl(MAPS.Sun), (t) => {
      sunMat.map = t;
      sunMat.color.set(0xffffff);
      sunMat.needsUpdate = true;
    });
    for (const b of bodies) {
      const file = MAPS[b.name];
      if (!file || !b.mesh) continue;
      const mat = b.mesh.material as THREE.ShaderMaterial;
      loadSharedTexture(assetUrl(file), (t) => {
        mat.uniforms.uMap.value = t;
        mat.uniforms.uHasMap.value = 1;
      });
    }
  }

  const smooth = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function update(jd: number, camEarth: THREE.Vector3, skyDark: number, earthWorld?: THREE.Vector3): void {
    const camR = camEarth.length();
    if (camR > 2e7) requestTextures();
    if (Number.isNaN(planetsJd) || Math.abs(jd - planetsJd) > PLANET_ORBIT_REFRESH_DAYS) {
      fillOrbits(jd, 'planets');
      planetsJd = jd;
    }
    if (Number.isNaN(moonJd) || Math.abs(jd - moonJd) > 1) {
      fillOrbits(jd, 'moon');
      moonJd = jd;
    }
    const eh = heliocentricPosition('Earth', jd);
    const s = eclipticToApp([-eh[0], -eh[1], -eh[2]]);
    sunPos.set(s[0], s[1], s[2]);
    sun.position.copy(sunPos);
    sunWorldUniform.value.copy(sunPos);
    if (earthWorld) sunWorldUniform.value.add(earthWorld);
    sunGlow.position.copy(sunPos);
    sunFlare.position.copy(sunPos);
    sunFlareMat.opacity = 0.9 * skyDark;
    sunFlare.visible = skyDark > 0.02;
    sunGlowMat.opacity = 0.5 + 0.5 * skyDark;
    const showLabels = skyDark * smooth(3e7, 2e8, camR);
    if (sunLabel) {
      sunLabel.position.copy(sunPos);
      sunLabel.visible = showLabels > 0.02;
      (sunLabel.material as THREE.SpriteMaterial).opacity = showLabels;
    }

    const planetOrbits = skyDark * smooth(4e9, 6e10, camR) * 0.55;
    const moonOrbit = skyDark * smooth(1.5e7, 1.2e8, camR) * (1 - smooth(4e10, 2e11, camR)) * 0.6;

    for (const b of bodies) {
      let p: Vec3;
      if (b.name === 'Earth') p = [0, 0, 0];
      else if (b.name === 'Moon') p = eclipticToApp(moonGeocentricPosition(jd));
      else {
        const h = heliocentricPosition(b.name, jd);
        p = eclipticToApp([h[0] - eh[0], h[1] - eh[1], h[2] - eh[2]]);
      }
      b.pos.set(p[0], p[1], p[2]);
      if (b.mesh) {
        b.mesh.position.copy(b.pos);
        if (b.name === 'Moon') {
          // Tidally locked: the map's prime meridian (+X of the sphere) faces Earth.
          tmp.copy(b.pos).negate().normalize();
          b.mesh.quaternion.setFromUnitVectors(X_AXIS, tmp);
        }
      }
      const dist = Math.max(1, tmp.copy(camEarth).sub(b.pos).length());
      const angular = b.radius / dist;
      // Dot only while the disc is under a few pixels; it would cover a resolved planet.
      const dotA = skyDark * (1 - smooth(0.0015, 0.004, angular)) * smooth(2e5, 2e6, dist);
      b.dot.position.copy(b.pos);
      (b.dot.material as THREE.SpriteMaterial).opacity = dotA;
      b.dot.visible = dotA > 0.02 && b.name !== 'Earth' ? true : b.name === 'Earth' && camR > 5e8 && dotA > 0.02;
      if (b.label) {
        b.label.position.copy(b.pos);
        const la = showLabels * smooth(15, 40, dist / b.radius) * (b.name === 'Moon' ? 1 - smooth(5e10, 3e11, camR) : 1);
        (b.label.material as THREE.SpriteMaterial).opacity = la;
        b.label.visible = la > 0.02 && (b.name !== 'Earth' || camR > 3e8);
      }
      if (b.orbit) {
        const mat = b.orbit.material as THREE.LineBasicMaterial;
        if (b.name === 'Moon') {
          b.orbit.position.set(0, 0, 0);
          mat.opacity = moonOrbit;
        } else {
          b.orbit.position.copy(sunPos);
          mat.opacity = planetOrbits;
        }
        b.orbit.visible = mat.opacity > 0.01;
      }
    }
  }

  function dispose(): void {
    for (const d of disposables) d.dispose();
    group.traverse((o) => {
      if (o instanceof THREE.Sprite && o.material.map && o.material.map !== dotTex) {
        o.material.map.dispose();
        o.material.dispose();
      }
    });
  }

  // Bodies are millions of km away: the ground haze must never swallow them.
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && 'fog' in m) (m as THREE.Material & { fog: boolean }).fog = false;
  });

  return { group, update, sunPos, dispose };
}
