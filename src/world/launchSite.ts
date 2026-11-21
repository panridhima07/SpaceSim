// Launch site scene: ground disc, sand clearing, concrete pad, launch controller, rail,
// blast deflector, reference pole and north marker.
//
// Local frame at the pad: +Y up, +X east, +Z south (north = -Z). The group sits at
// (0, R_EARTH + alt, 0) - origin each frame (floating origin).
// Model rockets are 0.3 to 3 m tall, so every pad detail is sized at that scale.
//
// Materials: the ground and sand use MeshBasicMaterial so the grass stays a bright flat green
// regardless of lighting. Everything else is MeshLambertMaterial (metalness is black without an
// environment map). The group owns a blue-sky HemisphereLight and a fixed-direction 'PadKeyLight'
// so the pad is bright at any time of day.

import * as THREE from 'three';
import { R_EARTH, type Vec3 } from '../types';

const GROUND_RADIUS = 30_000;
const GROUND_HAZE_START = 18_000; // m, grass fades to horizon haze from here to the rim
const GRASS_COLOR = 0x6fae4f;
const HAZE_COLOR = 0xbfe3ff;
const SAND_COLOR = 0xe6d5a0;
const SAND_RADIUS = 8; // m
const PAD_SIZE = 2; // m, square slab
const PAD_THICKNESS = 0.03; // m
const CONTROLLER_DISTANCE = 5; // m from the pad centre
const CONTROLLER_SIZE = 0.2; // m
const DEFLECTOR_RADIUS = 0.125; // m, 25 cm disc
const DEFLECTOR_THICKNESS = 0.01; // m
const RAIL_SIDE_OFFSET = 0.03; // m, keeps the rail clear of a rocket at the origin
const RAIL_SECTION = 0.008; // m, square cross-section (must stay <= 0.01)
const POLE_OFFSET = 0.6; // m, reference pole distance from the rail
/** Grid levels: lines every `spacing` metres out to `extent`, alpha fading linearly to 0. */
const GRID_LEVELS: { spacing: number; extent: number; alpha: number }[] = [
  { spacing: 1, extent: 20, alpha: 0.4 },
  { spacing: 10, extent: 200, alpha: 0.35 },
  { spacing: 100, extent: 2000, alpha: 0.3 },
];

export interface LaunchSite {
  group: THREE.Group;
  /** Place the site for the current floating origin and launch altitude above R_EARTH. */
  update(origin: Vec3, launchAltitude: number): void;
  /**
   * Set the rail. railAngle is the tilt from vertical (rad). railAzimuth is the compass
   * direction it tilts toward (rad, clockwise from north). Azimuth 90 degrees tilts toward +X.
   */
  setRail(railLength: number, railAngle: number, railAzimuth: number): void;
}

/**
 * Flat ground disc: vertex colours fade from grass to horizon haze between
 * GROUND_HAZE_START and the rim, so the edge of the disc is not a hard line.
 */
function buildGroundGeometry(): THREE.BufferGeometry {
  const radii = [
    0, 5, 10, 25, 60, 150, 400, 1000, 2500, 5000, 9000, 14000, 18000, 21000, 24000, 27000, 29000,
    GROUND_RADIUS,
  ];
  const SEG = 96;
  const grass = new THREE.Color(GRASS_COLOR);
  const haze = new THREE.Color(HAZE_COLOR);
  const positions: number[] = [];
  const colors: number[] = [];
  for (const r of radii) {
    const t = Math.min(1, Math.max(0, (r - GROUND_HAZE_START) / (GROUND_RADIUS - GROUND_HAZE_START)));
    const c = grass.clone().lerp(haze, t * t * (3 - 2 * t));
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      positions.push(r * Math.cos(a), 0, r * Math.sin(a));
      colors.push(c.r, c.g, c.b);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < radii.length - 1; i++) {
    for (let s = 0; s < SEG; s++) {
      const a = i * SEG + s;
      const b = i * SEG + ((s + 1) % SEG);
      const c = (i + 1) * SEG + s;
      const d = (i + 1) * SEG + ((s + 1) % SEG);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

/** Grid lines with per-vertex alpha that fades with distance from the pad. */
function buildGrid(): THREE.LineSegments {
  const pts: number[] = [];
  const cols: number[] = [];
  const addSeg = (ax: number, az: number, bx: number, bz: number, alpha: number, extent: number) => {
    pts.push(ax, 0, az, bx, 0, bz);
    const aa = alpha * Math.max(0, 1 - Math.hypot(ax, az) / extent);
    const ba = alpha * Math.max(0, 1 - Math.hypot(bx, bz) / extent);
    cols.push(1, 1, 1, aa, 1, 1, 1, ba);
  };
  for (const { spacing, extent, alpha } of GRID_LEVELS) {
    const n = Math.round(extent / spacing);
    for (let k = -n; k <= n; k++) {
      const g = k * spacing;
      for (let s = -n; s < n; s++) {
        const a = s * spacing;
        const b = a + spacing;
        addSeg(g, a, g, b, alpha, extent); // along Z
        addSeg(a, g, b, g, alpha, extent); // along X
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
  const grid = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
  );
  grid.name = 'grid';
  return grid;
}

function makeNorthTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 96px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', 64, 70);
  return new THREE.CanvasTexture(canvas);
}

export function buildLaunchSite(opts: { railLength: number }): LaunchSite {
  const group = new THREE.Group();
  group.name = 'launchSite';

  // Ground disc, flat, sunk 1 cm.
  const ground = new THREE.Mesh(
    buildGroundGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  ground.name = 'ground';
  ground.position.y = -0.01;
  group.add(ground);

  // Sand clearing around the pad, between the ground and the pad slab.
  const sandGeo = new THREE.CircleGeometry(SAND_RADIUS, 48);
  sandGeo.rotateX(-Math.PI / 2);
  const sand = new THREE.Mesh(sandGeo, new THREE.MeshBasicMaterial({ color: SAND_COLOR }));
  sand.name = 'sandClearing';
  sand.position.y = -0.004;
  group.add(sand);

  // Grid: 1 m near the pad, 10 m out to 200 m, 100 m out to 2 km.
  const grid = buildGrid();
  grid.position.y = -0.001;
  group.add(grid);

  // Concrete pad, 2 m x 2 m x 3 cm, top surface at y = 0.
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(PAD_SIZE, PAD_THICKNESS, PAD_SIZE),
    new THREE.MeshLambertMaterial({ color: 0xcfcfca }),
  );
  pad.name = 'pad';
  pad.position.y = -PAD_THICKNESS / 2;
  group.add(pad);

  // Blast deflector plate under the rocket.
  const deflector = new THREE.Mesh(
    new THREE.CylinderGeometry(DEFLECTOR_RADIUS, DEFLECTOR_RADIUS, DEFLECTOR_THICKNESS, 24),
    new THREE.MeshLambertMaterial({ color: 0x8c9196 }),
  );
  deflector.name = 'blastDeflector';
  deflector.position.y = DEFLECTOR_THICKNESS / 2;
  group.add(deflector);

  // Launch controller: flat-shaded 20 cm box 5 m away, joined to the pad by a thin cable.
  const diag = CONTROLLER_DISTANCE / Math.SQRT2;
  const controller = new THREE.Mesh(
    new THREE.BoxGeometry(CONTROLLER_SIZE, CONTROLLER_SIZE, CONTROLLER_SIZE),
    new THREE.MeshLambertMaterial({ color: 0xff9f1c, flatShading: true }),
  );
  controller.name = 'launchController';
  controller.position.set(diag, CONTROLLER_SIZE / 2, diag);
  group.add(controller);

  const cableGeo = new THREE.BufferGeometry();
  const nearCorner = diag - CONTROLLER_SIZE / 2;
  cableGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [PAD_SIZE / 2, 0.01, PAD_SIZE / 2, nearCorner, 0.05, nearCorner],
      3,
    ),
  );
  const cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: 0x333333 }));
  cable.name = 'controllerCable';
  group.add(cable);

  // Lights owned by the pad: a sky/ground hemisphere fill and a fixed key light from up-east-south.
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x7a8f5a, 0.6);
  hemi.name = 'PadHemiLight';
  group.add(hemi);
  const key = new THREE.DirectionalLight(0xfff6e8, 1.2);
  key.name = 'PadKeyLight';
  key.position.set(1, 2, 1); // +X east, +Y up, +Z south
  group.add(key);
  group.add(key.target); // target sits at the group origin

  // Rail. The pivot sits at a fixed sideways offset; the rail mesh is a unit-height box
  // from its base, scaled to railLength and rotated to the tilt direction.
  const railPivot = new THREE.Group();
  railPivot.name = 'railPivot';
  const railGeo = new THREE.BoxGeometry(RAIL_SECTION, 1, RAIL_SECTION);
  railGeo.translate(0, 0.5, 0);
  const rail = new THREE.Mesh(
    railGeo,
    new THREE.MeshLambertMaterial({ color: 0xe4e7ea }),
  );
  rail.name = 'rail';
  railPivot.add(rail);
  group.add(railPivot);

  // Reference pole: 1 m, ten 10 cm stripes alternating red and white. Sits 0.6 m from the rail.
  const pole = new THREE.Group();
  pole.name = 'referencePole';
  const stripeGeo = new THREE.BoxGeometry(0.05, 0.1, 0.05);
  const redMat = new THREE.MeshLambertMaterial({ color: 0xc62828 });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
  for (let i = 0; i < 10; i++) {
    const stripe = new THREE.Mesh(stripeGeo, i % 2 === 0 ? redMat : whiteMat);
    stripe.position.y = 0.05 + i * 0.1;
    pole.add(stripe);
  }
  group.add(pole);

  // Compass "N" marker on the ground, 3 m north (-Z).
  const northTex = makeNorthTexture();
  const northMarker = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: northTex,
      transparent: true,
      depthWrite: false,
    }),
  );
  northMarker.geometry.rotateX(-Math.PI / 2);
  northMarker.name = 'northMarker';
  northMarker.position.set(0, 0.005, -3);
  group.add(northMarker);

  function setRail(railLength: number, railAngle: number, railAzimuth: number): void {
    const sinT = Math.sin(railAngle);
    const cosT = Math.cos(railAngle);
    const sinA = Math.sin(railAzimuth);
    const cosA = Math.cos(railAzimuth);
    // Direction the rail points: tilt from vertical toward the azimuth (north = -Z).
    const dir = new THREE.Vector3(sinT * sinA, cosT, -sinT * cosA).normalize();
    rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    rail.scale.set(1, Math.max(railLength, 1e-3), 1);
    // Sideways offset perpendicular to the azimuth, so the rail misses a rocket at the origin.
    railPivot.position.set(cosA * RAIL_SIDE_OFFSET, 0, sinA * RAIL_SIDE_OFFSET);
    // Pole stays POLE_OFFSET metres from the rail on the far side of it.
    pole.position.set(
      cosA * (RAIL_SIDE_OFFSET - POLE_OFFSET),
      0,
      sinA * (RAIL_SIDE_OFFSET - POLE_OFFSET),
    );
  }

  setRail(opts.railLength, 0, 0);

  function update(origin: Vec3, launchAltitude: number): void {
    group.position.set(-origin[0], R_EARTH + launchAltitude - origin[1], -origin[2]);
  }

  return { group, update, setRail };
}
