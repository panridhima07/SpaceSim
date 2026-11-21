import * as THREE from 'three';

export interface OrbitElementsInput {
  /** Semi-major axis, m. */
  a: number;
  /** Eccentricity, 0 <= e < 1. */
  e: number;
  /** Inclination, rad. */
  i: number;
  /** Right ascension of ascending node, rad. */
  raan: number;
  /** Argument of periapsis, rad. */
  argp: number;
}

export interface GroundTrackSample {
  /** Position in app frame (Y-up, Earth-centred, metres). */
  position: [number, number, number];
  /** Earth rotation angle, rad. */
  earthRotationRad: number;
}

export interface LatLon {
  latDeg: number;
  lonDeg: number;
}

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Sample `n` points around a Keplerian ellipse in the app frame (Y-up, Earth-centred, m).
 * Converts from the physics library's Z-up ECI frame via (x, y, z) -> (x, z, -y).
 */
export function orbitPoints(
  elements: OrbitElementsInput,
  n: number,
): [number, number, number][] {
  const count = Math.max(3, Math.floor(n));
  const { a, e, i, raan, argp } = elements;
  const p = a * (1 - e * e);

  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosW = Math.cos(argp);
  const sinW = Math.sin(argp);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  const pts: [number, number, number][] = [];
  for (let k = 0; k < count; k++) {
    const nu = (2 * Math.PI * k) / count;
    const r = p / (1 + e * Math.cos(nu));
    const xp = r * Math.cos(nu);
    const yp = r * Math.sin(nu);

    // Perifocal -> ECI (Z-up)
    const x1 = xp * cosW - yp * sinW;
    const y1 = xp * sinW + yp * cosW;

    const x2 = x1;
    const y2 = y1 * cosI;
    const z2 = y1 * sinI;

    const x = x2 * cosO - y2 * sinO;
    const y = x2 * sinO + y2 * cosO;
    const z = z2;

    // Z-up -> Y-up app frame: (x, z, -y)
    pts.push([x, z, -y]);
  }
  return pts;
}

/**
 * Convert app-frame positions and Earth rotation angles to geocentric lat/lon (degrees).
 */
export function groundTrackPoints(samples: GroundTrackSample[]): LatLon[] {
  return samples.map(({ position, earthRotationRad }) => {
    const [x, y, z] = position;
    const c = Math.cos(earthRotationRad);
    const s = Math.sin(earthRotationRad);
    const xf = x * c - z * s;
    const zf = x * s + z * c;
    const r = Math.hypot(xf, y, zf);
    if (r === 0) return { latDeg: 0, lonDeg: 0 };
    const latDeg = Math.asin(Math.max(-1, Math.min(1, y / r))) * RAD_TO_DEG;
    const lonDeg = Math.atan2(-zf, xf) * RAD_TO_DEG;
    return { latDeg, lonDeg };
  });
}

/**
 * Build a closed-loop THREE.Line from app-frame orbit points.
 */
export function buildOrbitLine(
  points: [number, number, number][],
  color = 0x4cc9f0,
): THREE.Line {
  const closed = points.length > 0 ? [...points, points[0]] : [];
  const positions = new Float32Array(closed.length * 3);
  for (let i = 0; i < closed.length; i++) {
    positions[i * 3] = closed[i][0];
    positions[i * 3 + 1] = closed[i][1];
    positions[i * 3 + 2] = closed[i][2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(geometry, material);
  line.name = 'orbit-line';
  return line;
}
