// Aerodynamic forces and moments on a slender launch vehicle, in body axes
// (X toward the nose). Covers continuum flow from subsonic to hypersonic, the
// transition to free-molecular flow in the upper atmosphere, and stagnation heating.

import { boosterCount, type VehicleRuntime, type VehicleSpec } from '../vehicle/types.ts';
import { stackLayout } from '../vehicle/massprops.ts';
import type { Vec3 } from '../math/vec.ts';

/** Typical zero-lift drag of a launch vehicle: transonic rise, then a slow supersonic decline. */
export const DEFAULT_CD_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.3],
  [0.5, 0.28],
  [0.8, 0.3],
  [0.95, 0.4],
  [1.05, 0.52],
  [1.2, 0.55],
  [1.5, 0.48],
  [2, 0.4],
  [3, 0.32],
  [5, 0.27],
  [8, 0.25],
  [25, 0.25],
];

export function interpolate(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

export interface AeroGeometry {
  refArea: number; // frontal area, m^2
  planformArea: number; // side-on area, m^2
  length: number;
  /** Station (from the stack base) where the nose normal force acts. */
  xNose: number;
  /** Station where the body cross-flow force acts (planform centroid). */
  xBody: number;
  /**
   * Where potential-flow (nose) lift is generated: one entry for the vehicle's nose and one
   * for each strap-on booster's nose. `cnA` is normal-force slope times that body's own
   * frontal area, m^2 per rad.
   */
  noseLift: { cnA: number; x: number }[];
  noseRadius: number;
  cdTable: ReadonlyArray<readonly [number, number]>;
  cnAlphaNose: number;
  crossflowK: number;
}

export function aeroGeometry(v: VehicleSpec, rt: VehicleRuntime): AeroGeometry {
  const { base, top, length } = stackLayout(v, rt);
  let maxR = 0;
  let planform = 0;
  let planMoment = 0;
  let boosterArea = 0;
  const cnAlpha = v.aero?.cnAlphaNose ?? 2;
  const noseLift: { cnA: number; x: number }[] = [];
  v.stages.forEach((s, i) => {
    if (!rt.stages[i].attached) return;
    const n = boosterCount(s);
    const a = 2 * s.radius * s.length * n;
    planform += a;
    planMoment += a * (base[i] + s.length / 2);
    if (s.parallel) {
      boosterArea += n * Math.PI * s.radius ** 2;
      noseLift.push({ cnA: cnAlpha * n * Math.PI * s.radius ** 2, x: base[i] + s.length - s.radius });
    } else maxR = Math.max(maxR, s.radius);
  });
  const fairingOn = rt.fairingAttached && !!v.fairing;
  const topLen = fairingOn ? v.fairing!.length : v.payload.length;
  const topR = fairingOn ? v.fairing!.radius : (v.payload.radius ?? maxR * 0.8);
  maxR = Math.max(maxR, topR);
  planform += 2 * topR * topLen * 0.8;
  planMoment += 2 * topR * topLen * 0.8 * (top + topLen * 0.45);
  const noseLen = fairingOn ? (v.fairing!.noseLength ?? 0.4 * v.fairing!.length) : topLen * 0.5;
  noseLift.unshift({ cnA: cnAlpha * Math.PI * maxR * maxR, x: length - 0.5 * noseLen });
  return {
    noseLift,
    refArea: Math.PI * maxR * maxR + boosterArea,
    planformArea: planform,
    length,
    xNose: length - 0.5 * noseLen,
    xBody: planMoment / planform,
    noseRadius: v.aero?.noseRadius ?? Math.max(0.3, 0.25 * topR),
    cdTable: v.aero?.cdTable ?? DEFAULT_CD_TABLE,
    cnAlphaNose: cnAlpha,
    crossflowK: v.aero?.crossflowK ?? 1.1,
  };
}

export interface AeroResult {
  force: Vec3; // body axes, N
  moment: Vec3; // about the CG, body axes, N m
  mach: number;
  dynamicPressure: number; // Pa
  alpha: number; // total angle of attack, rad
  cd: number;
  knudsen: number;
  /** Station of the centre of pressure, m from the stack base. */
  cp: number;
}

/**
 * @param vb     velocity of the vehicle relative to the air, body axes, m/s
 * @param omega  body angular velocity, rad/s
 * @param cg     CG station from the stack base, m
 */
export function aeroForces(
  vb: Vec3,
  omega: Vec3,
  rho: number,
  speedOfSound: number,
  meanFreePath: number,
  g: AeroGeometry,
  cg: number,
): AeroResult {
  const V = Math.hypot(vb[0], vb[1], vb[2]);
  const mach = V / speedOfSound;
  const q = 0.5 * rho * V * V;
  const kn = meanFreePath / g.length;
  if (V < 1e-3 || rho <= 0) {
    return { force: [0, 0, 0], moment: [0, 0, 0], mach, dynamicPressure: q, alpha: 0, cd: 0, knudsen: kn, cp: g.xNose };
  }
  const lat = Math.hypot(vb[1], vb[2]);
  const cosA = vb[0] / V;
  const sinA = lat / V;
  const alpha = Math.atan2(lat, vb[0]);

  // Continuum drag from the table; free-molecular flow (Kn > 10) behaves like a hail of
  // independent molecules with Cd about 2.2. Blend across the transition regime.
  const f = Math.min(1, Math.max(0, (Math.log10(kn) + 2) / 3));
  const cd0 = interpolate(g.cdTable, mach) * (1 - f) + 2.2 * f;

  const qA = q * g.refArea;
  const axial = -qA * cd0 * cosA * Math.abs(cosA);
  // Normal force: potential (nose) lift of each body plus viscous cross-flow on the sides.
  const potential = q * sinA * Math.abs(cosA);
  const lBody = g.xBody - cg;
  const nBody = q * g.planformArea * g.crossflowK * (1 - f + (2.2 * f) / g.crossflowK) * sinA * sinA;
  let nTot = nBody;
  let armMoment = nBody * lBody;
  // Pitch / yaw damping: rotation gives each station a local cross-flow of omega * arm.
  let damp = 0.5 * rho * V * g.planformArea * g.crossflowK * 0.025 * g.length * g.length;
  for (const b of g.noseLift) {
    const arm = b.x - cg;
    nTot += potential * b.cnA;
    armMoment += potential * b.cnA * arm;
    damp += 0.5 * rho * V * b.cnA * arm * arm;
  }
  // The force pushes along the cross-flow, i.e. opposite to the body's lateral velocity.
  const ny = lat > 1e-9 ? -vb[1] / lat : 0;
  const nz = lat > 1e-9 ? -vb[2] / lat : 0;

  return {
    force: [axial, nTot * ny, nTot * nz],
    // (arm, 0, 0) x (0, Fy, Fz) = (0, -arm Fz, arm Fy)
    moment: [0, -armMoment * nz - damp * omega[1], armMoment * ny - damp * omega[2]],
    mach,
    dynamicPressure: q,
    alpha,
    cd: cd0,
    knudsen: kn,
    cp: nTot > 1e-9 ? cg + armMoment / nTot : g.xNose,
  };
}

/** Stagnation-point convective heat flux, W/m^2 (Sutton-Graves, Earth air). */
export function stagnationHeatFlux(rho: number, speed: number, noseRadius: number): number {
  return 1.7415e-4 * Math.sqrt(rho / noseRadius) * speed ** 3;
}

/** Free-molecular heat flux, W/m^2. Fairings are released when this falls below about 1135. */
export function freeMolecularHeatFlux(rho: number, speed: number): number {
  return 0.5 * rho * speed ** 3;
}
