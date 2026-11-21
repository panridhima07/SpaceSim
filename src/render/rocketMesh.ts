// Builds three.js geometry for a RocketModel.
//
// Local frame: rocket axis along +Y, nose pointing +Y, origin at the nose tip.
// A component whose fore end is at station x occupies local y in [-(x+length), -x].
// Units are metres, not rescaled.

import * as THREE from 'three';
import type {
  Component, FinSet, InnerTube, MassComponent, NoseCone, NoseShape, Parachute,
  Ring, RocketModel, BodyTube, Transition,
} from '../types';

const COLORS = {
  nose: 0xe2552f,
  tube: 0xf2f1ec,
  fin: 0x2b3440,
  transition: 0x8a9099,
  ring: 0xc9c5b8,
  mass: 0x1d1f24,
  chute: 0xf0622a,
};

const RADIAL_SEGMENTS = 48;
const NOSE_POINTS = 64;
const CUTAWAY_OPACITY = 0.25;

// ---------- Nose profile ----------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function noseRadius(shape: NoseShape, shapeParam: number, R: number, L: number, s: number): number {
  const u = s / L;
  switch (shape) {
    case 'conical':
      return R * u;
    case 'ogive': {
      const rho = (R * R + L * L) / (2 * R);
      return Math.sqrt(Math.max(0, rho * rho - (L - s) * (L - s))) + R - rho;
    }
    case 'ellipsoid': {
      const q = (L - s) / L;
      return R * Math.sqrt(Math.max(0, 1 - q * q));
    }
    case 'power': {
      const p = shapeParam || 0.5;
      return R * Math.pow(u, p);
    }
    case 'parabolic': {
      const K = shapeParam;
      return (R * (2 * u - K * u * u)) / (2 - K);
    }
    case 'haack': {
      const C = shapeParam;
      const th = Math.acos(clamp(1 - 2 * u, -1, 1));
      const val = (th - Math.sin(2 * th) / 2 + C * Math.pow(Math.sin(th), 3)) / Math.PI;
      return R * Math.sqrt(Math.max(0, val));
    }
    default:
      return R * u;
  }
}

/** Nose profile as [s, r] pairs, s from the tip (0) to the base (L), n points. */
export function noseProfile(
  shape: NoseShape,
  shapeParam: number,
  R: number,
  L: number,
  n: number,
): [number, number][] {
  const count = Math.max(2, Math.floor(n));
  if (!(L > 0) || !(R > 0)) return [[0, 0], [Math.max(L, 0), Math.max(R, 0)]];
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const s = (L * i) / (count - 1);
    out.push([s, noseRadius(shape, shapeParam, R, L, s)]);
  }
  return out;
}

// ---------- Materials and helpers ----------

function makeMaterial(color: number, transparent: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  if (transparent) {
    m.transparent = true;
    m.opacity = CUTAWAY_OPACITY;
    m.depthWrite = false;
  }
  return m;
}

function addMesh(
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  component: Component,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = component.id;
  mesh.userData.component = component;
  parent.add(mesh);
  return mesh;
}

/** Open-ended cylinder whose fore end is at station x. */
function tubeGeometry(rTop: number, rBottom: number, x: number, length: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, length, RADIAL_SEGMENTS, 1, true);
  g.translate(0, -(x + length / 2), 0);
  return g;
}

/** Closed solid cylinder (for masses and chutes). */
function solidCylinderGeometry(radius: number, x: number, length: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, 32, 1, false);
  g.translate(0, -(x + length / 2), 0);
  return g;
}

// ---------- Fins ----------

function finPlanform(c: FinSet): THREE.Vector2[] {
  if (c.finShape === 'freeform' && c.points && c.points.length >= 3) {
    return c.points.map(([a, r]) => new THREE.Vector2(a, r));
  }
  if (c.finShape === 'elliptical') {
    const pts: THREE.Vector2[] = [];
    const n = 40;
    const half = c.rootChord / 2;
    for (let k = 0; k <= n; k++) {
      const th = (Math.PI * k) / n;
      pts.push(new THREE.Vector2(half - half * Math.cos(th), c.span * Math.sin(th)));
    }
    return pts;
  }
  // trapezoid (also the fallback for freeform without points)
  return [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(c.sweepLength, c.span),
    new THREE.Vector2(c.sweepLength + c.tipChord, c.span),
    new THREE.Vector2(c.rootChord, 0),
  ];
}

function buildFinGeometry(c: FinSet): THREE.BufferGeometry {
  const t = Math.max(c.thickness, 1e-4);
  const shape = new THREE.Shape(finPlanform(c));
  const geom = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });
  // Centre on the fin plane thickness.
  geom.translate(0, 0, -t / 2);
  // Shape x (axial, aft) -> -Y ; shape y (radial) -> +X ; extrude z -> +Z.
  // Root leading edge sits at station x on the body surface.
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1),
  );
  basis.setPosition(c.bodyRadius, -c.x, 0);
  geom.applyMatrix4(basis);

  // Cant: rotate about the fin's radial axis through the middle of the root chord.
  if (c.cant) {
    const pivot = new THREE.Vector3(c.bodyRadius, -(c.x + c.rootChord / 2), 0);
    const cant = new THREE.Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationX(c.cant))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    geom.applyMatrix4(cant);
  }
  return geom;
}

// ---------- Component builders ----------

function buildNose(c: NoseCone, cutaway: boolean): { geometry: THREE.BufferGeometry; transparent: boolean } {
  const prof = noseProfile(c.shape, c.shapeParam, c.baseRadius, c.length, NOSE_POINTS);
  const pts = prof.map(([s, r]) => new THREE.Vector2(r, -(c.x + s)));
  return { geometry: new THREE.LatheGeometry(pts, RADIAL_SEGMENTS), transparent: cutaway };
}

function buildRing(c: Ring): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, c.outerRadius, 0, Math.PI * 2, false);
  if (c.innerRadius > 0) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, c.innerRadius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(c.length, 1e-4),
    bevelEnabled: false,
    curveSegments: RADIAL_SEGMENTS,
    steps: 1,
  });
  // Extrude runs along +Z; rotate so it runs along -Y (aft), then place at station x.
  g.rotateX(Math.PI / 2);
  g.translate(0, -c.x, 0);
  return g;
}

// ---------- Public API ----------

/**
 * Build the 3D group for a rocket. Origin at the nose tip, +Y toward the nose.
 * Without `cutaway`, only external parts are built. With `cutaway`, internal parts
 * (inner tube, rings, masses, parachutes) are added and external tubes/nose are
 * rendered transparent.
 */
export function buildRocketMesh(rocket: RocketModel, opts: { cutaway?: boolean } = {}): THREE.Group {
  const cutaway = !!opts.cutaway;
  const group = new THREE.Group();
  group.name = rocket.name || 'rocket';

  for (const c of rocket.components) {
    switch (c.kind) {
      case 'nosecone': {
        const { geometry, transparent } = buildNose(c, cutaway);
        addMesh(group, geometry, makeMaterial(COLORS.nose, transparent), c);
        break;
      }
      case 'bodytube': {
        const c2 = c as BodyTube;
        const geometry = tubeGeometry(c2.outerRadius, c2.outerRadius, c2.x, c2.length);
        addMesh(group, geometry, makeMaterial(COLORS.tube, cutaway), c2);
        break;
      }
      case 'transition': {
        const c2 = c as Transition;
        // Cylinder top is +Y, i.e. the fore end.
        const geometry = tubeGeometry(c2.foreRadius, c2.aftRadius, c2.x, c2.length);
        addMesh(group, geometry, makeMaterial(COLORS.transition, cutaway), c2);
        break;
      }
      case 'finset': {
        const count = Math.max(1, Math.round(c.count));
        const geometry = buildFinGeometry(c);
        const material = makeMaterial(COLORS.fin, false);
        for (let i = 0; i < count; i++) {
          const mesh = addMesh(group, geometry, material, c);
          mesh.rotation.y = (2 * Math.PI * i) / count;
        }
        break;
      }
      case 'innertube': {
        if (!cutaway) break;
        const c2 = c as InnerTube;
        const geometry = tubeGeometry(c2.outerRadius, c2.outerRadius, c2.x, c2.length);
        addMesh(group, geometry, makeMaterial(COLORS.tube, false), c2);
        break;
      }
      case 'ring': {
        if (!cutaway) break;
        addMesh(group, buildRing(c), makeMaterial(COLORS.ring, false), c);
        break;
      }
      case 'mass': {
        if (!cutaway) break;
        const c2 = c as MassComponent;
        const r = 0.6 * rocket.maxRadius;
        addMesh(group, solidCylinderGeometry(r, c2.x, c2.length), makeMaterial(COLORS.mass, false), c2);
        break;
      }
      case 'parachute': {
        if (!cutaway) break;
        const c2 = c as Parachute;
        const r = 0.7 * rocket.maxRadius;
        addMesh(group, solidCylinderGeometry(r, c2.x, c2.length), makeMaterial(COLORS.chute, false), c2);
        break;
      }
    }
  }
  return group;
}

/**
 * Two torus rings marking CG (blue) and CP (red). Add `group` as a child of the
 * rocket group; `update` sets their local y to -cgX and -cpX.
 */
export function buildCgCpMarkers(maxRadius: number): {
  group: THREE.Group;
  update(cgX: number, cpX: number): void;
} {
  const group = new THREE.Group();
  group.name = 'cgcp-markers';
  const ringRadius = 1.15 * maxRadius;
  const tube = Math.max(0.0015, 0.04 * maxRadius);

  const make = (name: string, color: number): THREE.Mesh => {
    const g = new THREE.TorusGeometry(ringRadius, tube, 12, 64);
    g.rotateX(Math.PI / 2); // lie in the XZ plane, ring axis along Y
    const m = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 }),
    );
    m.name = name;
    group.add(m);
    return m;
  };

  const cg = make('cg', 0x2f7de2);
  const cp = make('cp', 0xe23b3b);

  return {
    group,
    update(cgX: number, cpX: number) {
      cg.position.y = -cgX;
      cp.position.y = -cpX;
    },
  };
}

/** Dispose geometries and materials recursively. */
export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}
