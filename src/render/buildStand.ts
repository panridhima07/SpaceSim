import * as THREE from 'three';

export interface BuildStandOptions {
  /** Largest body radius of the rocket, metres. */
  maxRadius: number;
  /** Rocket length nose to tail, metres. */
  rocketLength: number;
}

const COLORS = {
  dark: 0x3a3d44,
  steel: 0x9aa3ad,
  cap: 0xf0622a,
} as const;

const FALLBACK_RADIUS = 0.0125;
const FALLBACK_LENGTH = 0.4;
const PLATE_THICKNESS = 0.004;
const FOOT_HEIGHT = 0.012;

function makeMat(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Thin cylinder joining point a to point b. */
function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

/**
 * Model-rocket launch pad. The top of the pad sits at y = 0 and the rocket's tail
 * rests on it. Everything except the launch rod is at y <= 0. Units are metres.
 */
export function buildBuildStand(opts: BuildStandOptions): THREE.Group {
  const R = positive(opts.maxRadius, FALLBACK_RADIUS);
  const L = positive(opts.rocketLength, FALLBACK_LENGTH);

  const group = new THREE.Group();
  group.name = 'build-stand';

  const darkMat = makeMat(COLORS.dark, 0.6, 0.3);
  const steelMat = makeMat(COLORS.steel, 0.4, 0.5);
  const capMat = makeMat(COLORS.cap, 0.5, 0.1);

  const t = PLATE_THICKNESS;
  const plateR = Math.max(3 * R, 0.05);
  const H = Math.max(0.25 * L, 0.08);
  const hubH = Math.max(0.02, 0.05 * H);
  const hubR = Math.max(0.012, 0.15 * plateR);
  const legR = Math.min(Math.max(0.004, 0.02 * plateR), 0.008);
  const footR = Math.max(0.012, 0.04 * plateR);
  const footRadial = 0.8 * plateR;

  // Blast-deflector plate, top face at y = 0.
  const deflector = new THREE.Mesh(new THREE.CylinderGeometry(plateR, plateR, t, 24), steelMat);
  deflector.name = 'deflector';
  deflector.position.set(0, -t / 2, 0);
  group.add(deflector);

  // Tripod legs with foot pads. Feet reach ground level y = -H.
  const legs = new THREE.Group();
  legs.name = 'legs';
  const hubTopY = -t - hubH / 2;
  for (let i = 0; i < 3; i++) {
    const theta = (i * 2 * Math.PI) / 3;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const top = new THREE.Vector3(cos * hubR * 0.5, hubTopY, sin * hubR * 0.5);
    const foot = new THREE.Vector3(cos * footRadial, -H + FOOT_HEIGHT, sin * footRadial);
    legs.add(strut(top, foot, legR, darkMat));

    const pad = new THREE.Mesh(new THREE.CylinderGeometry(footR, footR, FOOT_HEIGHT, 8), darkMat);
    pad.name = `foot-pad-${i + 1}`;
    pad.position.set(cos * footRadial, -H + FOOT_HEIGHT / 2, sin * footRadial);
    legs.add(pad);
  }
  group.add(legs);

  // Central hub joining the legs, directly under the plate.
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(hubR, hubR * 1.1, hubH, 12),
    darkMat,
  );
  base.name = 'base';
  base.position.set(0, -t - hubH / 2, 0);
  group.add(base);

  // Launch rod standing on the plate, clear of the rocket body.
  const rodR = Math.max(0.0016, 0.04 * R);
  const rodTop = Math.max(0.9 * L, 0.3);
  const rodX = 1.35 * R + rodR;
  const capR = Math.max(2.2 * rodR, 0.004);

  const rod = new THREE.Group();
  rod.name = 'rod';
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rodR, rodR, rodTop, 8), steelMat);
  shaft.name = 'rod-shaft';
  shaft.position.set(rodX, rodTop / 2, 0);
  rod.add(shaft);

  // Orange safety cap; its top face sits flush with the rod tip.
  const cap = new THREE.Mesh(new THREE.SphereGeometry(capR, 10, 8), capMat);
  cap.name = 'rod-cap';
  cap.position.set(rodX, rodTop - capR, 0);
  rod.add(cap);
  group.add(rod);

  return group;
}
