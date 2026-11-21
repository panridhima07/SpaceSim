// Shared contract for every module. Do not change without updating all users.
//
// CONVENTIONS
// - SI units everywhere (m, kg, s, N, rad) unless a name says otherwise.
// - Rocket "station" x: distance aft from the nose tip along the axis, metres.
// - Body frame: +Y points toward the nose. Station x maps to body y = -x.
// - World frame: Earth-centred, non-rotating. Launch site at (0, R_EARTH + alt, 0).
//   At the launch site +X is east, +Y is up, +Z is south (right-handed, three.js style).
// - Quaternions are [x, y, z, w] and rotate body vectors into the world frame.
//   Identity quaternion = rocket upright at the launch site.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const R_EARTH = 6_371_000; // m
export const MU_EARTH = 3.986004418e14; // m^3/s^2
export const G0 = 9.80665;

// ---------- Rocket model ----------

export type NoseShape = 'conical' | 'ogive' | 'ellipsoid' | 'power' | 'parabolic' | 'haack';

interface BaseComponent {
  id: string;
  name: string;
  /** Station of the fore end, metres aft of the nose tip (absolute, already resolved). */
  x: number;
  /** Axial length, metres. */
  length: number;
  /** Bulk material density kg/m^3 (0 if unknown or not applicable). */
  density: number;
  /** If set, use this mass (kg) instead of computing from geometry. */
  massOverride?: number;
  /** If set, CG station (absolute, m from nose tip) instead of computed. */
  cgOverride?: number;
  /** Optional custom 24-bit RGB colour override for rendering (e.g. 0x4da3ff). */
  color?: number;
  /** OpenRocket surface finish ('rough', 'unfinished', 'normal', 'smooth', 'polished', ...). */
  finish?: string;
}

export interface NoseCone extends BaseComponent {
  kind: 'nosecone';
  shape: NoseShape;
  shapeParam: number;
  baseRadius: number;
  /** Wall thickness; 0 means solid. */
  thickness: number;
  /** True for a tail cone: wide end forward, tip aft. */
  flipped?: boolean;
}

export interface BodyTube extends BaseComponent {
  kind: 'bodytube';
  outerRadius: number;
  thickness: number;
  /** True when this tube acts as an interstage decoupler separating upper & lower stages. */
  isDecoupler?: boolean;
}

export interface Transition extends BaseComponent {
  kind: 'transition';
  foreRadius: number;
  aftRadius: number;
  thickness: number;
  /** Curve of the outline; absent means a straight cone. */
  shape?: NoseShape;
  shapeParam?: number;
  /** True when the curve is a nose shape with its front cut off (OpenRocket "clipped"). */
  clipped?: boolean;
}

export interface FinSet extends BaseComponent {
  kind: 'finset';
  count: number;
  /** For trapezoid/elliptical fins. `length` equals rootChord. */
  rootChord: number;
  tipChord: number;
  /** Semi-span (root to tip), metres. */
  span: number;
  /** Axial distance the tip leading edge sits aft of the root leading edge. */
  sweepLength: number;
  thickness: number;
  /** Cant angle, rad. */
  cant: number;
  /** Body radius where the fins mount. */
  bodyRadius: number;
  finShape: 'trapezoid' | 'elliptical' | 'freeform';
  /** Edge profile; affects pressure and base drag. Default 'rounded'. */
  crossSection?: 'square' | 'rounded' | 'airfoil';
  /** Freeform outline: [axial from root LE, radial from body surface] points, metres. */
  points?: [number, number][];
  /** Angle of the first fin about the rocket axis, rad. Default 0. */
  angleOffset?: number;
  /** Root fillet radius, metres. */
  filletRadius?: number;
  /** Through-the-wall tab: radial depth into the body, length along the root, and
   *  distance of its fore end aft of the root leading edge. Metres. */
  tabHeight?: number;
  tabLength?: number;
  tabOffset?: number;
}

export interface MotorRef {
  manufacturer: string;
  designation: string;
  diameter: number;
  length: number;
  /** Ejection delay seconds; NaN or Infinity for plugged/none. */
  delay: number;
}

export interface InnerTube extends BaseComponent {
  kind: 'innertube';
  outerRadius: number;
  thickness: number;
  isMotorMount: boolean;
  /** How far the motor sticks out past the aft end of the tube. */
  overhang: number;
  motor?: MotorRef;
  /** Optional radial symmetry count (>= 2) for side-mounted booster pods. */
  radialCount?: number;
  /** Radial centre-to-centre offset from rocket axis (m) for side-mounted pods. */
  radialOffset?: number;
  /** Cluster: centre of every tube as [x, z] metres from the rocket axis. Absent for one tube. */
  cluster?: [number, number][];
}

export interface Parachute extends BaseComponent {
  kind: 'parachute';
  diameter: number;
  cd: number;
  deployEvent: 'apogee' | 'ejection' | 'altitude';
  /** For 'altitude': deploy when descending below this height above ground. */
  deployAltitude: number;
  deployDelay: number;
  /** Total mass of canopy and lines, kg. */
  mass: number;
}

export interface MassComponent extends BaseComponent {
  kind: 'mass';
  mass: number;
}

/** Centering rings, bulkheads, couplers, engine blocks, launch lugs. */
export interface Ring extends BaseComponent {
  kind: 'ring';
  outerRadius: number;
  innerRadius: number;
  /** True for a launch lug: it sits OUTSIDE the body and adds drag. */
  external?: boolean;
  /** What the ring is in the source file. */
  ringType?: 'centeringring' | 'bulkhead' | 'tubecoupler' | 'engineblock' | 'launchlug' | 'railbutton' | 'shoulder';
  /** External parts only: radius of the body surface they sit on, metres. */
  mountRadius?: number;
  /** External parts only: angle about the rocket axis, rad. Default 0. */
  angle?: number;
  /** External parts only: how many copies along the axis (default 1) and their spacing, metres. */
  instanceCount?: number;
  instanceSeparation?: number;
}

export type Component =
  | NoseCone | BodyTube | Transition | FinSet | InnerTube | Parachute | MassComponent | Ring;

export interface StageBoundary {
  /** Stage name from the .ork file, if present. */
  name: string;
  /** Index of the first component in `RocketModel.components` belonging to this stage. */
  startComponent: number;
  /** Number of components in `RocketModel.components` belonging to this stage. */
  componentCount: number;
  /** Designation of the motor in this stage (from motor mount), if any. */
  motorDesignation?: string;
  /** Stage-level mass override, kg. */
  massOverride?: number;
  /** Whether the stage-level mass override replaces all subcomponents' mass. */
  overrideSubcomponentsMass?: boolean;
}

/**
 * Bodies mounted beside the main stack: strap-on boosters, pods and tube fins.
 * They fly as fixed parts of the rocket: mass, drag and lift are counted, motors
 * inside them do not fire, and they do not separate.
 */
export interface SideBody {
  id: string;
  name: string;
  type: 'booster' | 'pod' | 'tubefin';
  /** How many copies sit evenly around the rocket axis. */
  count: number;
  /** Distance from the rocket axis to each copy's own axis, metres. */
  radialOffset: number;
  /** Angle of the first copy about the rocket axis, rad. */
  angle: number;
  /** The copy's own parts on its own axis; every x is an absolute station. */
  components: Component[];
}

export interface RocketModel {
  name: string;
  /** Flat list, every x absolute. External parts (nose, tubes, transitions) are in fore-to-aft order. */
  components: Component[];
  /** Overall length nose tip to aft end. */
  length: number;
  /** Largest body radius; reference area is pi * maxRadius^2. */
  maxRadius: number;
  stageCount: number;
  /** Stage boundaries in order from the top (sustainer) down to the booster. */
  stages?: StageBoundary[];
  /** Things the parser could not represent. Shown to the user. */
  warnings: string[];
  /** Boosters, pods and tube fins beside the main stack. */
  sideBodies?: SideBody[];
}

// ---------- Motor ----------

export interface Motor {
  manufacturer: string;
  designation: string;
  diameter: number;
  length: number;
  /** Loaded mass, kg. */
  totalMass: number;
  propellantMass: number;
  /** [time s, thrust N], time ascending, starts at t=0, ends at thrust 0. */
  curve: [number, number][];
  burnTime: number;
  /** N s */
  totalImpulse: number;
  /** True if the curve is a hand approximation rather than certified data. */
  approximate: boolean;
}

// ---------- Physics ----------

export interface Atmosphere {
  rho: number;
  pressure: number;
  temperature: number;
  soundSpeed: number;
}

export interface MassProps {
  mass: number;
  /** CG station from nose tip. */
  cgX: number;
  /** Moment of inertia about the long (roll) axis. */
  iRoll: number;
  /** Moment of inertia about a transverse axis through the CG. */
  iPitch: number;
}

export interface AeroProps {
  /** Reference area, pi * maxRadius^2. */
  refArea: number;
  /** Reference length = body diameter (one calibre). */
  refLength: number;
  /** Normal force coefficient slope, per radian. */
  cnAlpha: number;
  /** Centre of pressure station from nose tip. */
  cpX: number;
  /** Zero-angle-of-attack drag coefficient at this Mach number. */
  cd: number;
  /** Sum over components of cnAlpha_i * (x_i - cgX)^2, m^2. Pitch damping torque =
   *  -0.5 * rho * v * refArea * dampSum * omega_transverse. */
  dampSum: number;
}

export type AtmosphereFn = (altitude: number) => Atmosphere;
/** tBurn = seconds since ignition (<=0 means full motor; null motor means no motor). */
export type MassPropsFn = (rocket: RocketModel, motor: Motor | null, tBurn: number) => MassProps;
export type AeroPropsFn = (rocket: RocketModel, mach: number, cgX: number) => AeroProps;
export type ThrustFn = (motor: Motor, tBurn: number) => number;

export interface PhysicsDeps {
  atmosphere: AtmosphereFn;
  massProps: MassPropsFn;
  aeroProps: AeroPropsFn;
  thrust: ThrustFn;
}

export interface SimConfig {
  railLength: number;
  /** Tilt from vertical, rad. */
  railAngle: number;
  /** Compass direction the rail tilts toward, rad clockwise from north. */
  railAzimuth: number;
  windSpeed: number;
  /** Compass direction the wind blows FROM, rad clockwise from north. */
  windDirection: number;
  /** Gust amplitude as a fraction of windSpeed (0..1). */
  gust: number;
  /** Launch site altitude above mean radius, m. */
  launchAltitude: number;
  /** Overrides the motor's ejection delay if set. */
  ejectionDelay?: number;
  /** Optional multi-stage motors in firing order (booster first, sustainer last). */
  stageMotors?: { motor: Motor; ignitionDelay?: number }[];
}

export interface Controls {
  /** Thrust-vector gimbal angles, rad. Zero for a passive rocket. */
  gimbalPitch: number;
  gimbalYaw: number;
}

export type FlightPhase = 'pad' | 'rail' | 'boost' | 'coast' | 'descent' | 'landed' | 'crashed';

export interface SimState {
  t: number;
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  /** Angular velocity in the body frame, rad/s. */
  omega: Vec3;
  phase: FlightPhase;
  // Derived, refreshed every step:
  mass: number;
  /** Height above the launch site, m. */
  altitude: number;
  speed: number;
  mach: number;
  /** Angle of attack, rad. */
  alpha: number;
  dynamicPressure: number;
  thrust: number;
  drag: number;
  /** Magnitude of non-gravitational acceleration in g. */
  accelG: number;
  cgX: number;
  cpX: number;
  /** (cpX - cgX) / diameter. */
  stabilityCal: number;
  chuteDeployed: boolean;
}

export type FlightEventType =
  | 'ignition' | 'liftoff' | 'railExit' | 'burnout'
  | 'stage separation' | 'stage ignition'
  | 'apogee' | 'ejection' | 'chuteDeploy' | 'landing' | 'crash' | 'maxQ';

export interface FlightEvent {
  t: number;
  type: FlightEventType;
  altitude: number;
  speed: number;
  message: string;
}

export interface Sim {
  readonly state: SimState;
  readonly events: FlightEvent[];
  /** Samples of state recorded at ~50 Hz of sim time, for replay and analysis. */
  readonly log: SimState[];
  readonly done: boolean;
  /** Start the motor. */
  ignite(): void;
  /** Advance by dt seconds of sim time (internally sub-stepped). */
  step(dt: number, controls?: Controls): void;
}

export type FlawSeverity = 'info' | 'warning' | 'critical';

export interface Flaw {
  id: string;
  severity: FlawSeverity;
  title: string;
  /** Plain-language explanation including the numbers. */
  detail: string;
  /** How to fix it. */
  fix: string;
  /** Sim time when it occurred, if it is a flight flaw. */
  t?: number;
  value?: number;
  limit?: number;
  unit?: string;
}

// ---------- Stress test (many headless flights) ----------

export interface SweepResult {
  label: string;
  config: SimConfig;
  apogee: number;
  maxSpeed: number;
  railExitSpeed: number;
  /** Speed at ground contact. */
  landingSpeed: number;
  /** Horizontal distance from the pad at touchdown, m. */
  drift: number;
  /** Largest angle of attack while under thrust, rad. */
  maxAlpha: number;
  outcome: 'landed' | 'crashed' | 'timeout';
  flaws: Flaw[];
  worst: FlawSeverity | 'ok';
}

export interface StressReport {
  /** Varying wind speed, everything else as configured. */
  wind: SweepResult[];
  /** Varying rail tilt. */
  railAngle: SweepResult[];
  /** Varying ejection delay. */
  delay: SweepResult[];
  /** Highest tested wind with no critical flaw (null if even calm air fails). */
  maxSafeWind: number | null;
  /** Ejection delay giving the lowest deployment speed. */
  bestDelay: number | null;
  /** Plain-language findings, most important first. */
  summary: string[];
}
