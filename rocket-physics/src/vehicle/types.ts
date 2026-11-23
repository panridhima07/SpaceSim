// What a launch vehicle is made of. All SI. Stations (positions along the vehicle) are
// measured in metres from the base of the part they belong to, positive toward the nose.

export interface EngineSpec {
  name: string;
  /** Vacuum thrust of ONE engine at full throttle, N. */
  thrustVac: number;
  /** Vacuum specific impulse, s. */
  ispVac: number;
  /** Sea-level specific impulse, s. Used to derive the nozzle exit area if `exitArea` is absent. */
  ispSL?: number;
  /** Nozzle exit area of one engine, m^2. Sets how much thrust back-pressure costs. */
  exitArea?: number;
  /** Lowest stable throttle, 0-1. 1 means the engine cannot throttle. */
  minThrottle?: number;
  /** Thrust-vector gimbal limit, rad. 0 for a fixed nozzle. */
  maxGimbal?: number;
  /** Gimbal slew rate, rad/s. */
  gimbalRate?: number;
  /** Time to reach about 95 % of commanded thrust, s. */
  spoolTime?: number;
  /** Number of ignitions available. Default 1. */
  ignitions?: number;
  /**
   * Solid motors: [time since ignition (s), fraction of thrustVac]. A solid cannot be
   * throttled or shut down; it follows this curve until the grain is gone.
   */
  thrustCurve?: ReadonlyArray<readonly [number, number]>;
}

export interface TankSpec {
  name?: string;
  /** Propellant mass loaded, kg. */
  propellantMass: number;
  /** 'liquid' settles to the bottom and drains downward; 'solid' burns evenly along its length. */
  kind?: 'liquid' | 'solid';
  /** Station of the tank bottom from the stage base, m. */
  bottom: number;
  /** Length of the propellant column when full, m. */
  length: number;
  /** Radius, m. Defaults to the stage radius. */
  radius?: number;
  /** Share of the engine mass flow drawn from this tank. Shares of a stage must sum to 1. */
  flowFraction: number;
}

export interface StageSpec {
  name: string;
  /** Structure, engines and everything else that is not usable propellant, kg. */
  dryMass: number;
  length: number;
  radius: number;
  /** Where the dry mass sits, as a fraction of the stage length from its base. Default 0.4. */
  dryCgFraction?: number;
  tanks: TankSpec[];
  engine: EngineSpec;
  engineCount: number;
  /** Fraction of the propellant that cannot be burned. Default 0.005. */
  residualFraction?: number;
  /** Strap-on boosters: `count` copies of this stage around the first core stage. */
  /** `phase` turns the ring of boosters about the vehicle axis, rad (drawing only). */
  parallel?: { count: number; radialOffset: number; attachStation: number; phase?: number };
  /**
   * 'liftoff'  light on the pad
   * 'stack'    light after the stage below separates (default for upper stages)
   * {afterLiftoff}  air-light at a fixed time, e.g. a core that ignites while boosters burn
   */
  ignition?: 'liftoff' | 'stack' | { afterLiftoff: number };
  /** Seconds between burnout and separation. Default 2. */
  separationDelay?: number;
  /** Seconds between separation of the stage below and ignition. Default 3. */
  ignitionDelay?: number;
  /** Reaction-control torque available about each body axis, N m. */
  rcsTorque?: number;
}

export interface FairingSpec {
  mass: number;
  length: number;
  radius: number;
  /** Length of the tapered nose section, m. Default 40 % of the fairing. */
  noseLength?: number;
}

export interface AeroSpec {
  /** Zero-lift drag coefficient vs Mach number, referenced to the frontal area. */
  cdTable?: ReadonlyArray<readonly [number, number]>;
  /** Nose normal-force slope, per rad. Slender-body theory gives 2. */
  cnAlphaNose?: number;
  /** Cross-flow drag coefficient for body lift at angle of attack. */
  crossflowK?: number;
  /** Nose radius of curvature for stagnation heating, m. */
  noseRadius?: number;
}

export interface VehicleSpec {
  name: string;
  /** Core stages from the bottom up, plus any strap-on boosters (marked `parallel`). */
  stages: StageSpec[];
  payload: { mass: number; length: number; radius?: number };
  fairing?: FairingSpec;
  aero?: AeroSpec;
}

/** Things that change in flight but are not integrated: what is attached, what is burning. */
export interface StageRuntime {
  attached: boolean;
  engineOn: boolean;
  /** Actual throttle 0-1 (lags the command). */
  throttle: number;
  ignitionTime: number;
  ignitionsUsed: number;
  burnedOut: boolean;
  burnoutTime: number;
}

export interface VehicleRuntime {
  stages: StageRuntime[];
  fairingAttached: boolean;
}

export function initialRuntime(v: VehicleSpec): VehicleRuntime {
  return {
    stages: v.stages.map(() => ({
      attached: true,
      engineOn: false,
      throttle: 0,
      ignitionTime: NaN,
      ignitionsUsed: 0,
      burnedOut: false,
      burnoutTime: NaN,
    })),
    fairingAttached: !!v.fairing,
  };
}

/** Index of the first tank of each stage in the flat propellant array. */
export function tankOffsets(v: VehicleSpec): number[] {
  const out: number[] = [];
  let n = 0;
  for (const s of v.stages) {
    out.push(n);
    n += s.tanks.length;
  }
  return out;
}

/** Full propellant load, one entry per tank (per booster for strap-ons). */
export function initialPropellant(v: VehicleSpec): number[] {
  return v.stages.flatMap((s) => s.tanks.map((t) => t.propellantMass));
}

export const boosterCount = (s: StageSpec): number => s.parallel?.count ?? 1;
