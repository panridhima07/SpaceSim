// App entry point. Glues the modules together: loading, the sim, the 3D scene and the UI.
//
// Scene space is the physics world minus a floating origin chosen each frame: the rocket CG
// in chase/onboard/map modes, the launch-site point in pad mode. Every object is drawn at
// (worldPos - origin). Effects and the trajectory take physics positions and subtract the
// origin themselves.

import { cachedDeps } from '../physics/cache';
import * as THREE from 'three';
import {
  G0,
  MU_EARTH,
  R_EARTH,
  type Flaw,
  type Component,
  type InnerTube,
  type Motor,
  type MotorRef,
  type Parachute,
  type Quat,
  type RocketModel,
  type Sim,
  type SimConfig,
  type SimState,
  type StressReport,
  type Vec3,
} from '../types';
import { createSim } from '../physics/sim';
import { analyzeFlight } from '../physics/flaws';
import { liftoffStats, type LiftoffStats } from '../physics/liftoff';
import { initCloud } from '../cloud/session';
import { createImportFix } from '../cloud/importFix';
import { pullDesigns, pushDesign, removeDesign } from '../cloud/designSync';
import { prepareFlight, runMissionFlight, runStressTest, runsOnServer } from '../cloud/runPhysics';
import { logUsage } from '../cloud/usage';
import { atmosphere } from '../physics/atmosphere';
import { windVector } from '../physics/wind';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { add, quatRotate, len } from '../physics/vec';
import { parseOrkXml } from '../ork/parser';
import { fetchMotorFromThrustCurve } from '../ork/thrustcurve';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { ALL_MOTORS, findMotor, thrustAt } from '../ork/motors';
import { buildRocketMesh, buildCgCpMarkers, disposeGroup } from '../render/rocketMesh';
import { gradeRocket, PART_ICONS, PART_LABELS } from '../render/parts/grade';
import { buildForceArrows } from '../render/arrows';
import {
  applyFlatStyle,
  buildExhaust,
  buildParachute,
  buildSky,
  buildSmokeTrail,
  buildTrajectoryLine,
  smokeForThrust,
} from '../render/effects';
import { buildSolarSystem } from '../world/solarSystem';
import { buildLaunchSite } from '../world/launchSite';
import { SimClock } from '../world/clock';
import { createUI } from './ui';
import { mountHero } from './hero';
import { createCameraRig, type CameraRig } from './cameras';
import type { CameraMode, ToggleName, UI } from './uiTypes';
import {
  aftRadiusOf,
  createEmptyDesign,
  duplicatePart,
  findPart,
  foreRadiusOf,
  fromRocketModel,
  moveExternalPart,
  removePart,
  toRocketModel,
  updatePart,
  type Design,
  type ExternalComponent,
} from '../builder/design';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  replacePresent,
  undoHistory,
  type History,
} from '../builder/history';
import type { PartPreset } from '../builder/parts';
import { applySnap, computeSnapPoints, type SnapPoint } from '../builder/snap';
import {
  deleteSavedDesign,
  listSavedDesigns,
  saveDesign,
} from '../builder/storage';
import { importRocketFile, type ImportFormat } from '../io/importer';
import { MAX_FILE_BYTES } from '../io/limits';
import { exportDesign, type ExportFormat } from '../io/exporter';
import { buildShareUrl, decodeDesignFromHash, SHARE_HASH_KEY } from '../io/shareLink';
import { saveBlob } from './saveFile';
import { shareBaseUrl } from './native';
import {
  evaluateChallenges,
  loadCompletedChallenges,
  markChallengesCompleted,
} from '../builder/challenges';
import { createBuilderView } from '../builder/view';
import { friendlyName } from '../builder/friendly';
import { createBuilderUI, type BuilderStats } from './builderUi';
import { createMissionView } from './missionView';
import { createMissionUI } from './missionUi';
import { isAbortError, runMission } from '../mission/client';
import { getMission, type MissionDef } from '../mission/vehicles';
import { snapshotAt } from '../mission/snapshot';
import type { FlightRecord } from '../mission/record';
import { startPilotedFlight, type PilotedFlight } from '../mission/pilot';
import { createPilotControls } from './pilotControls';
import { createManualFlight } from './manualFlight';
import type { FlyOptions } from '../mission/fly';
import type { ScenarioId } from '../mission/engine';

type Markers = ReturnType<typeof buildCgCpMarkers>;
type Exhaust = ReturnType<typeof buildExhaust>;

const PHYSICS_DEPS = cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt });
const TWR_TARGET = 5; // thrust-to-weight wanted over the first half second
const RAIL_EXIT_TARGET = 15; // m/s, slowest safe speed off the rail
const SEVERITY_RANK: Record<Flaw['severity'], number> = { critical: 0, warning: 1, info: 2 };
const SMOKE_ALT_LIMIT = 30_000; // m, no exhaust puffs above this
const TRAIL_INTERVAL_S = 0.05; // 20 Hz of sim time
const WARP_CAP_ATMOSPHERE = 10;
const WARP_CAP_ALTITUDE = 100_000; // m
// One sim step covers at most 2000 s of coasting (20000 substeps of 0.1 s): above this warp a
// frame would ask for more and time would quietly run slower than the figure shown.
const WARP_CAP_COAST = 10_000;

/** Takeoff plays at this fraction of real time, easing to full speed. */
const LIFTOFF_SLOW = 0.2;
const LIFTOFF_HOLD_S = 0.5; // sim seconds at the slowest rate
const LIFTOFF_EASE_S = 0.9; // sim seconds to reach real time

/**
 * Time scaling at 1x warp. A model rocket is off the rail in a fifth of a second, so takeoff plays
 * in slow motion, at the same rate for every rocket: a heavy one visibly labours and a light one
 * leaps. The last metres under a parachute are slowed a little so the touchdown can be seen.
 */
function realisticTimeFactor(s: Sim | null, warp: number): number {
  if (!s || s.done || warp !== 1) return 1;
  const { phase, t, altitude } = s.state;
  if (phase !== 'descent' && t < LIFTOFF_HOLD_S + LIFTOFF_EASE_S) {
    const u = Math.max(0, Math.min(1, (t - LIFTOFF_HOLD_S) / LIFTOFF_EASE_S));
    return LIFTOFF_SLOW + (1 - LIFTOFF_SLOW) * u * u * (3 - 2 * u);
  }
  if (phase === 'descent' && altitude < 15) {
    const u = Math.max(0, Math.min(1, altitude / 15));
    return 0.65 + 0.35 * u;
  }
  return 1;
}

// ---------- Renderer, scene and fixed world objects ----------

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app element');

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
/** Phones get a lower pixel-ratio cap: fill rate is their bottleneck. */
function targetPixelRatio(): number {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return Math.min(window.devicePixelRatio, coarse ? 1.5 : 2);
}
renderer.setPixelRatio(targetPixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1e13);

const solar = buildSolarSystem();
const site = buildLaunchSite({ railLength: 1 });
const sky = buildSky();
const smoke = buildSmokeTrail();
const trail = buildTrajectoryLine();
const arrows = buildForceArrows();
const cameraRig: CameraRig = createCameraRig(camera, renderer.domElement);

scene.add(solar.group, site.group, sky.mesh, smoke.object, trail.line, arrows.group);

// C toggles the constellation lines (visible once the stars are, i.e. from the map view or space).
let constellationsOn = false;
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.toLowerCase() !== 'c') return;
  if (appMode !== 'flight') return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
  constellationsOn = solar.setConstellations(!constellationsOn);
});

// ---------- App state ----------

const clock = new SimClock();
const toggles: Record<ToggleName, boolean> = { cutaway: false, forces: false, markers: true, trail: true };

let rocket: RocketModel | null = null;
let motor: Motor | null = null;
let motorRef: MotorRef | null = null;
let motorPeak = 0;
let extraMotors: Motor[] = [];
/** Pre-flight design checks for the loaded rocket. `covers` lists the flight flaw ids they duplicate. */
interface StaticFlaw {
  flaw: Flaw;
  covers: string[];
}
let staticFlaws: StaticFlaw[] = [];
let lastStress: StressReport | null = null;
let sim: Sim | null = null;
let launched = false;
let replayT: number | null = null;
let flightDuration = 0;
let finishHandled = false;
let lastEventCount = -1;
let emitAcc = 0;
let trailAcc = 0;
let padLift = 0; // m the pad sits below the rocket CG at t = 0
let activeConfig: SimConfig;

let rocketRoot: THREE.Group | null = null;
let markers: Markers | null = null;
let exhaust: Exhaust | null = null;
let chute: THREE.Group | null = null;
let chuteDeployTime: number | null = null;
let chuteLandedTime: number | null = null;
const chuteDir = new THREE.Vector3(0, 1, 0);
const chuteSettleAxis = new THREE.Vector3(1, 0, 0);

let lastNow = performance.now();

// ---------- Render on demand ----------

/** Frames are drawn while now < renderWakeUntil (1.5 s covers OrbitControls damping). */
let renderWakeUntil = 0;
function requestRender(ms = 1500): void {
  const until = performance.now() + ms;
  if (until > renderWakeUntil) renderWakeUntil = until;
}
/** True while the translucent title overlay covers the flight scene. */
let heroActive = false;
let lastHeroRenderMs = -Infinity;
const HERO_FRAME_MS = 100;

for (const type of [
  'pointerdown',
  'pointerup',
  'click',
  'wheel',
  'touchstart',
  'touchmove',
  'keydown',
  'keyup',
  'input',
  'change',
  'resize',
]) {
  window.addEventListener(type, () => requestRender(), { capture: true, passive: true });
}
window.addEventListener(
  'pointermove',
  (e) => {
    if (e.buttons !== 0) requestRender();
  },
  { capture: true, passive: true },
);
renderer.domElement.addEventListener('pointerdown', () => requestRender(), { passive: true });
renderer.domElement.addEventListener('wheel', () => requestRender(), { passive: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestRender();
});

// ---------- Helpers ----------

function errorMessage(e: unknown): string {
  // A failed fetch is a TypeError too ("Failed to fetch", Safari "Load failed"): say so plainly.
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    return 'no connection to the server (check the internet connection and try again)';
  }
  // Programming errors (TypeError etc.) mean nothing to a user: log them, show a plain line.
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError) {
    console.error(e);
    return 'something went wrong inside the app (details in the browser console)';
  }
  return e instanceof Error ? e.message : String(e);
}

function motorKey(m: Motor): string {
  return `${m.manufacturer} ${m.designation}`.trim();
}

function peakThrust(m: Motor): number {
  return m.curve.reduce((max, [, f]) => Math.max(max, f), 0);
}

/** Scene-space point for a physics position. */
function toScene(p: Vec3, origin: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
}

function inFlight(): boolean {
  return launched && sim !== null && !sim.done;
}

/** Sample of the log nearest to t, or null if the log is empty. */
function logAt(log: SimState[], t: number): SimState | null {
  if (log.length === 0) return null;
  if (t <= log[0].t) return log[0];
  const last = log.length - 1;
  if (t >= log[last].t) return log[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (log[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return t - log[lo].t <= log[hi].t - t ? log[lo] : log[hi];
}

function displayState(): SimState | null {
  if (!sim) return null;
  if (replayT === null) return sim.state;
  return logAt(sim.log, replayT) ?? sim.state;
}

function firstParachute(r: RocketModel): Parachute | undefined {
  return r.components.find((c): c is Parachute => c.kind === 'parachute');
}

function findMotorRef(r: RocketModel): MotorRef | null {
  const mount = r.components.find(
    (c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount,
  );
  return mount?.motor ?? null;
}

// ---------- Motors and rocket info ----------

/** All selectable motors keyed by "manufacturer designation". Extra .eng motors win. */
function motorChoices(): Map<string, Motor> {
  const byKey = new Map<string, Motor>();
  for (const m of [...ALL_MOTORS, ...extraMotors]) byKey.set(motorKey(m), m);
  return byKey;
}

function refreshMotorList(): void {
  const choices = [...motorChoices().values()];
  ui.setMotors(
    choices.map((m) => ({
      designation: motorKey(m),
      label: `${motorKey(m)}  ${Math.round(m.totalImpulse)} N s`,
    })),
    motor ? motorKey(motor) : null,
  );
}

/** Design checks that need no flight: stability, motor fit and thrust-to-weight. */
function preflightFlaws(
  r: RocketModel,
  m: Motor | null,
  stabilityCal: number,
): StaticFlaw[] {
  const out: StaticFlaw[] = [];
  if (!m) {
    out.push({
      flaw: {
        id: 'static-no-motor',
        severity: 'critical',
        title: 'No motor selected',
        detail: 'The rocket has no motor, so it cannot fly.',
        fix: 'Select a motor that fits the motor mount and has a certified thrust curve.',
      },
      covers: ['no-motor'],
    });
    return out;
  }

  if (stabilityCal < 1) {
    out.push({
      flaw: {
        id: 'static-stability',
        severity: 'critical',
        title: stabilityCal < 0 ? 'Unstable: CP ahead of CG' : 'Unstable: stability margin under 1 calibre',
        detail: `The stability margin is ${stabilityCal.toFixed(2)} calibres before launch. An unstable rocket can flip or weathercock badly.`,
        fix: 'Move the CG forward (nose weight) or move the CP aft (larger or further-aft fins) until the margin is at least 1 calibre, ideally 1.5.',
        value: stabilityCal,
        limit: 1,
        unit: 'cal',
      },
      covers: ['unstable'],
    });
  } else if (stabilityCal < 1.5) {
    out.push({
      flaw: {
        id: 'static-stability',
        severity: 'warning',
        title: 'Marginal stability',
        detail: `The stability margin is ${stabilityCal.toFixed(2)} calibres before launch, which leaves little room for wind gusts.`,
        fix: 'Aim for a margin of 1.5 calibres or more by adding nose weight or enlarging the fins.',
        value: stabilityCal,
        limit: 1.5,
        unit: 'cal',
      },
      covers: ['unstable'],
    });
  } else if (stabilityCal > 3) {
    out.push({
      flaw: {
        id: 'static-stability',
        severity: 'warning',
        title: 'Overstable',
        detail: `The stability margin is ${stabilityCal.toFixed(2)} calibres before launch, so the rocket will weathercock hard into the wind.`,
        fix: 'Reduce fin area or move fins forward to bring the margin toward 1.5 to 2.5 calibres.',
        value: stabilityCal,
        limit: 3,
        unit: 'cal',
      },
      covers: ['overstable'],
    });
  }

  const mount = r.components.find(
    (c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount,
  );
  if (mount) {
    const innerDiameter = 2 * (mount.outerRadius - mount.thickness);
    if (m.diameter > innerDiameter) {
      out.push({
        flaw: {
          id: 'static-motor-fit',
          severity: 'warning',
          title: 'Motor too wide for the motor mount',
          detail: `The motor is ${(m.diameter * 1000).toFixed(1)} mm across but the motor mount is ${(innerDiameter * 1000).toFixed(1)} mm inside.`,
          fix: 'Choose a motor no wider than the motor mount, or enlarge the mount.',
          value: m.diameter,
          limit: innerDiameter,
          unit: 'm',
        },
        covers: [],
      });
    }
  }
  if (m.length > r.length) {
    out.push({
      flaw: {
        id: 'static-motor-length',
        severity: 'warning',
        title: 'Motor longer than the body',
        detail: `The motor is ${(m.length * 1000).toFixed(0)} mm long but the rocket is ${(r.length * 1000).toFixed(0)} mm.`,
        fix: 'Choose a shorter motor or lengthen the airframe.',
        value: m.length,
        limit: r.length,
        unit: 'm',
      },
      covers: [],
    });
  }

  if (r.stages && r.stages.length > 1 && !resolveStageMotors(r)) {
    out.push({
      flaw: {
        id: 'static-stage-motor',
        severity: 'warning',
        title: 'A stage has no known motor',
        detail: 'Not every stage names a motor that can be found, so the flight is simulated as a single stage with the selected motor.',
        fix: 'Give every stage a motor mount with a known motor, or load its .eng file.',
      },
      covers: [],
    });
  }

  const lift = takeoffFigures(r, m);
  const figures = `${lift.thrust.toFixed(1)} N of thrust against ${lift.weight.toFixed(1)} N of weight (${lift.twr.toFixed(2)} to 1)`;
  const rail = lift.railExitSpeed > 0 ? `about ${lift.railExitSpeed.toFixed(1)} m/s off the rail` : 'never reaching the end of the rail';
  if (lift.twr < TWR_TARGET || lift.railExitSpeed < RAIL_EXIT_TARGET) {
    const grounded = lift.railExitSpeed <= 0;
    out.push({
      flaw: {
        id: 'static-twr',
        severity: grounded ? 'critical' : 'warning',
        title: grounded ? 'Too heavy to leave the rail' : 'Low thrust-to-weight',
        detail: `The first half second gives ${figures}, ${rail}. Aim for ${TWR_TARGET} to 1 and at least ${RAIL_EXIT_TARGET} m/s.`,
        fix: 'Use a motor with more early thrust, reduce mass, or lengthen the rail.',
        value: lift.twr,
        limit: TWR_TARGET,
        unit: 'ratio',
      },
      covers: ['low-twr'],
    });
  }
  return out;
}

function refreshRocketInfo(): void {
  if (!rocket) {
    ui.setRocket(null);
    staticFlaws = [];
    return;
  }
  const mp = massProps(rocket, motor, 0);
  const ap = aeroProps(rocket, 0.1, mp.cgX);
  padLift = rocket.length - mp.cgX;
  const stageMotors = resolveStageMotors(rocket);
  const stabilityCal = (ap.cpX - mp.cgX) / (2 * rocket.maxRadius);
  ui.setRocket({
    name: rocket.name,
    length: rocket.length,
    diameter: 2 * rocket.maxRadius,
    mass: motor ? takeoffFigures(rocket, motor).mass : mp.mass,
    stabilityCal,
    motor: stageMotors ? stageMotors.map((s) => motorKey(s.motor)).join(' + ') : motor ? motorKey(motor) : null,
    warnings: rocket.warnings,
    parts: gradeRocket(rocket).filter((g) => g.external).map((g) => ({
      name: g.name,
      label: PART_LABELS[g.key],
      tier: g.tier,
      icon: PART_ICONS[g.key][g.tier],
      reasons: g.reasons.map((r) => r.text),
    })),
  });
  staticFlaws = preflightFlaws(rocket, motor, stabilityCal);
}

/** Thrust against weight on the pad, with the rail now set and every stage's motor aboard. */
function takeoffFigures(r: RocketModel, m: Motor): LiftoffStats {
  const cfg = ui.getConfig();
  return liftoffStats(r, m, cfg.railLength, resolveStageMotors(r), cfg.railAngle);
}

/** Choose a motor (or none), then refresh the lists and reset the flight. */
function applyMotor(m: Motor | null): void {
  clearStress();
  // Flaws from an earlier flight belong to the motor it flew with.
  lastFlightFlaws = [];
  motor = m;
  motorPeak = m ? peakThrust(m) : 0;
  refreshMotorList();
  refreshRocketInfo();
  resetSim();
}

/** Motors stored in the .ork replace any earlier motor with the same name. */
function adoptEmbeddedMotors(list: Motor[]): void {
  if (list.length === 0) return;
  const keys = new Set(list.map(motorKey));
  extraMotors = [...extraMotors.filter((m) => !keys.has(motorKey(m))), ...list];
}

/** Look up a motor missing from the local database on ThrustCurve.org. Never throws. */
async function lookupMotor(ref: MotorRef, forRocket: RocketModel): Promise<void> {
  const found = await fetchMotorFromThrustCurve(ref);
  if (!found) {
    ui.toast(`Motor ${ref.manufacturer} ${ref.designation} not in database - pick one or drop a .eng file`);
    return;
  }
  extraMotors = [...extraMotors.filter((m) => motorKey(m) !== motorKey(found)), found];
  // Select it only if the same rocket is still loaded and no flight is under way.
  if (rocket === forRocket && !inFlight()) applyMotor(found);
  else refreshMotorList();
  ui.toast(`Loaded ${found.designation} from ThrustCurve.org`);
}

function resolveMotorFromRef(): Motor | null {
  if (!motorRef) return null;
  return findMotor(motorRef, extraMotors);
}

// ---------- Rocket visuals ----------

function rebuildRocketVisuals(): void {
  if (!rocket) return;
  if (rocketRoot) {
    scene.remove(rocketRoot);
    disposeGroup(rocketRoot);
  }
  const body = buildRocketMesh(rocket, { cutaway: toggles.cutaway });
  applyFlatStyle(body);

  markers = buildCgCpMarkers(rocket.maxRadius);
  body.add(markers.group);

  exhaust = buildExhaust();
  exhaust.group.position.y = -rocket.length;
  body.add(exhaust.group);

  rocketRoot = body;
  scene.add(body);
  applyVisibilityToggles();
}

function removeChute(): void {
  if (!chute) return;
  scene.remove(chute);
  disposeGroup(chute);
  chute = null;
  chuteDeployTime = null;
  chuteLandedTime = null;
}

function applyVisibilityToggles(): void {
  if (markers) markers.group.visible = toggles.markers;
  trail.line.visible = toggles.trail;
  smoke.object.visible = toggles.trail;
  arrows.group.visible = toggles.forces;
}

// ---------- Loading ----------

function loadRocket(r: RocketModel): void {
  clearStress();
  rocket = r;
  motorRef = findMotorRef(r);
  motor = resolveMotorFromRef();
  motorPeak = motor ? peakThrust(motor) : 0;
  rebuildRocketVisuals();

  if (!motor) {
    if (motorRef) {
      // Not in the local database: try ThrustCurve.org in the background.
      void lookupMotor(motorRef, r);
    } else {
      ui.toast('No motor found in this file - pick one or drop a .eng file');
    }
  }
  refreshMotorList();
  refreshRocketInfo();
  cameraRig.setMode(cameraRig.mode, r.length);
  resetSim();
}

/** Bumped by every newer choice of rocket; an import that is no longer the latest is dropped. */
let importSeq = 0;

function loadSample(): void {
  importSeq++;
  // Nor may a saved fix for an earlier file arrive on top of the sample.
  importFix.clear();
  try {
    const model = parseOrkXml(SAMPLE_ORK_XML);
    // Keep the builder in step with the pad (enterBuilder only seeds from the pad when empty).
    builderHistory = createHistory(fromRocketModel(model));
    builderSelectedId = null;
    lastFlightFlaws = [];
    clearPlacement();
    loadRocket(model);
    if (appMode === 'builder') {
      refreshBuilder(true, true);
      builderView.frameRocket();
    }
  } catch (e) {
    ui.toast(`Could not load sample: ${errorMessage(e)}`);
  }
}

const FORMAT_LABELS: Record<ImportFormat, string> = {
  ork: 'OpenRocket .ork',
  rocksim: 'RockSim .rkt',
  'sfb-json': 'Astra .json',
  eng: 'RASP .eng',
  rse: 'RockSim .rse',
};

function toastWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  const extra = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
  // A dropped or missing part matters more than whatever happens to be listed first.
  const first = warnings.find((w) => /ignored|not supported|missing|not imported/i.test(w)) ?? warnings[0];
  ui.toast(`Note: ${first}${extra}`);
}

// Account storage, the consent decision and remembered import fixes (src/cloud).
const cloudReady = initCloud();
const importFix = createImportFix(cloudReady, {
  getDesign: () => currentDesign(),
  loadDesign: (design) => loadImportedDesign(design, toRocketModel(design), [], true),
  toast: (message) => ui.toast(message),
});

function loadImportedDesign(design: Design, model: RocketModel, embedded: Motor[] = [], keepFix = false): void {
  // A rocket that did not come from the file being fixed ends that file's fix bar.
  if (!keepFix) importFix.clear();
  if (embedded.length > 0) adoptEmbeddedMotors(embedded);
  builderHistory = createHistory(design);
  builderSelectedId = null;
  lastFlightFlaws = [];
  clearPlacement();
  loadRocket(model);
  if (appMode === 'builder') {
    refreshBuilder(true, true);
    builderView.frameRocket();
  }
}

async function importFile(file: File): Promise<void> {
  if (manualFlight.active) manualFlight.exit();
  const seq = ++importSeq;
  try {
    // Checked before reading: a huge file must not be pulled into memory first.
    if (file.size > MAX_FILE_BYTES) throw new Error('The file is too large (limit 20 MB).');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (seq !== importSeq) return;
    const result = await importRocketFile(bytes, file.name);
    if (seq !== importSeq) return;
    if (result.kind === 'motors') {
      if (result.motors.length === 0) {
        ui.toast(`No motors found in ${file.name}`);
        return;
      }
      adoptEmbeddedMotors(result.motors);
      ui.toast(`Added ${result.motors.length} motor(s) from ${file.name}`);
      if (rocket && !motor) {
        const found = resolveMotorFromRef();
        if (found) applyMotor(found);
      } else {
        refreshMotorList();
      }
      toastWarnings(result.warnings);
      return;
    }
    const design = result.design ?? (result.model ? fromRocketModel(result.model) : null);
    if (!design) {
      ui.toast(`No rocket design found in ${file.name}`);
      return;
    }
    const model = result.model ?? toRocketModel(design);
    loadImportedDesign(design, model, result.motors);
    logUsage('import');
    ui.toast(`Loaded "${result.name}" (${FORMAT_LABELS[result.format] ?? result.format})`);
    toastWarnings(result.warnings);
    // Files from other programs can be drawn wrong; our own JSON is already the user's design.
    if (result.format === 'ork' || result.format === 'rocksim') {
      void importFix.afterImport({ bytes, filename: file.name, format: result.format, parsedModel: model, imported: design });
    }
  } catch (e) {
    if (seq !== importSeq) return;
    ui.toast(`Could not load ${file.name}: ${errorMessage(e)}`);
  }
}

// ---------- Sim control ----------

function resolveStageMotors(r: RocketModel): { motor: Motor; ignitionDelay?: number }[] | undefined {
  if (!r.stages || r.stages.length <= 1) return undefined;
  // Stages are ordered top (sustainer) -> bottom (booster); firing order is booster first.
  const out: { motor: Motor; ignitionDelay?: number }[] = [];
  for (let i = r.stages.length - 1; i >= 0; i--) {
    const st = r.stages[i];
    const slice = r.components.slice(st.startComponent, st.startComponent + st.componentCount);
    const mount = slice.find((c): c is InnerTube => c.kind === 'innertube' && c.isMotorMount);
    const resolved = mount?.motor ? findMotor(mount.motor, extraMotors) : null;
    if (!resolved) return undefined;
    out.push({ motor: resolved, ignitionDelay: i === r.stages.length - 1 ? 0 : 0.2 });
  }
  return out.length > 1 ? out : undefined;
}

/** A launch waiting for the server to compute its flight. */
let launchAbort: AbortController | null = null;

function resetSim(): void {
  launchAbort?.abort();
  launchAbort = null;
  const baseCfg = ui.getConfig();
  const stageMotors = rocket ? resolveStageMotors(rocket) : undefined;
  activeConfig = stageMotors ? { ...baseCfg, stageMotors } : baseCfg;
  launched = false;
  finishHandled = false;
  flightDuration = 0;
  replayT = null;
  lastEventCount = -1;
  emitAcc = 0;
  trailAcc = 0;

  sim = rocket ? createSim(rocket, motor, activeConfig, PHYSICS_DEPS) : null;

  smoke.clear();
  trail.clear();
  removeChute();
  site.setRail(activeConfig.railLength, activeConfig.railAngle, activeConfig.railAzimuth);
  ui.setEvents([]);
  ui.setFlaws(staticFlaws.map((s) => s.flaw));
  ui.setReplay(0, 0);

  clock.warp = 1;
  clock.paused = false;
}

function launch(): void {
  if (!rocket) {
    ui.toast('Load a rocket first');
    return;
  }
  if (!motor) {
    ui.toast('Pick a motor first');
    return;
  }
  if (!sim) resetSim();
  if (!sim) return;
  if (launched || launchAbort) return;
  if (sim.done) {
    ui.toast('Flight is over - press Reset to fly again');
    return;
  }
  // The website has the server compute the flight. A hand-flown one needs the physics here, and
  // the app on a phone always flies on the phone.
  if (manualFlight.active || !runsOnServer()) ignite();
  else void launchFromServer(rocket, motor);
}

function ignite(): void {
  if (!sim || !rocket) return;
  sim.ignite();
  launched = true;
  // Dust and smoke off the pad, sized by the motor's push.
  smoke.burst([0, R_EARTH + activeConfig.launchAltitude - padLift, 0], motorPeak, rocket.maxRadius);
  logUsage('flight');
}

/** Fetch the flight, then light the motor. Falls back to computing it here. */
async function launchFromServer(forRocket: RocketModel, forMotor: Motor): Promise<void> {
  const ac = new AbortController();
  launchAbort = ac;
  ui.toast('Computing the flight on the server…');
  try {
    const run = await prepareFlight(forRocket, forMotor, activeConfig, { signal: ac.signal });
    // A reset, a new rocket or a new setting since the request makes this flight stale.
    if (launchAbort !== ac) return;
    launchAbort = null;
    sim = run.sim;
    lastEventCount = -1;
    if (run.fallbackReason) ui.toast(`Flying on this device: ${run.fallbackReason}.`);
    ignite();
  } catch (e) {
    if (launchAbort !== ac) return;
    launchAbort = null;
    if (!isAbortError(e)) ui.toast(`Could not launch: ${errorMessage(e)}`);
  }
}

function onConfigChanged(): void {
  clearStress();
  if (inFlight()) {
    ui.toast('Reset to apply');
    return;
  }
  // Flaws from a flight under the old settings no longer apply.
  lastFlightFlaws = [];
  // The rail length changes the takeoff checks.
  refreshRocketInfo();
  resetSim();
}

function onMotorPicked(designation: string): void {
  if (inFlight()) {
    ui.toast('Reset to apply');
    return;
  }
  const m = motorChoices().get(designation) ?? null;
  if (!m) {
    ui.toast(`Unknown motor ${designation}`);
    return;
  }
  applyMotor(m);
}

/** Runs once when the flight first reaches its end state. */
function onFlightDone(): void {
  finishHandled = true;
  if (!sim || !rocket) return;
  flightDuration = sim.state.t;
  const flight = analyzeFlight(sim, rocket, motor, activeConfig);
  const leftThePad = sim.events.some((e) => e.type === 'liftoff');
  if (manualFlight.active) {
    // A hand-flown flight says nothing about the design: show the design checks only, and leave
    // the challenges for flights the rocket makes by itself.
    ui.setFlaws(staticFlaws.map((s) => s.flaw));
    return;
  }
  lastFlightFlaws = flight;
  // Pre-flight checks join the flight flaws unless a flight flaw already says the same thing.
  const flightIds = new Set(flight.map((f) => f.id));
  const extra = staticFlaws
    .filter((s) => !s.covers.some((id) => flightIds.has(id)))
    .map((s) => s.flaw);
  ui.setFlaws([...flight, ...extra].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]));
  ui.setReplay(flightDuration, flightDuration);

  let apogee = 0;
  for (const s of sim.log) apogee = Math.max(apogee, s.altitude);
  const outcome = sim.state.phase === 'crashed' ? 'Crashed' : 'Landed';
  ui.toast(
    leftThePad
      ? `${outcome}. Apogee ${Math.round(apogee)} m, flight ${flightDuration.toFixed(1)} s.`
      : 'The rocket never left the pad: not enough thrust for its weight.',
  );

  // Evaluate engineering challenges on flight completion.
  const prevDone = loadCompletedChallenges();
  const passedNow = evaluateChallenges({
    rocket,
    motor,
    log: sim.log,
    events: sim.events,
    flaws: flight,
  })
    .filter((r) => r.passed)
    .map((r) => r.challenge);
  const newlyCompleted = passedNow.filter((c) => !prevDone.has(c.id));
  if (newlyCompleted.length > 0) {
    markChallengesCompleted(newlyCompleted.map((c) => c.id));
    cachedCompletedChallenges = loadCompletedChallenges();
    ui.toast(`Challenge complete: ${newlyCompleted[0].title}!`);
  }
}

function advanceSim(simDt: number): void {
  if (!sim || !inFlight() || replayT !== null) return;
  sim.step(simDt, manualFlight.active ? manualFlight.controls() : undefined);
  if (sim.done && !finishHandled) onFlightDone();
}

// ---------- Stress test ----------

/** Cancels the stress test that is out on the server (or running as its fallback here). */
let stressAbort: AbortController | null = null;

function clearStress(): void {
  stressAbort?.abort();
  stressAbort = null;
  lastStress = null;
  ui.setStress(null);
}

function startStress(): void {
  if (!rocket) {
    ui.toast('Load a rocket first');
    return;
  }
  if (!motor) {
    ui.toast('Pick a motor first');
    return;
  }
  if (stressAbort) return;
  lastStress = null;
  ui.setStress('running');
  // On the website the flights run on our server while the user waits; on a phone, or if the
  // server cannot be used, they run here, in slices that keep the page responsive.
  const ac = new AbortController();
  stressAbort = ac;
  const config = ui.getConfig();
  const forRocket = rocket;
  const forMotor = motor;
  void cloudReady
    .then(async (cloud) => {
      const accessToken = await cloud.accessToken();
      const r = await runStressTest(forRocket, forMotor, config, { accessToken, signal: ac.signal });
      if (stressAbort !== ac) return;
      stressAbort = null;
      lastStress = r.result;
      ui.setStress(r.result);
      const why = r.fallbackReason ? `: ${r.fallbackReason}` : '';
      ui.toast(r.ranOn === 'server' ? 'Stress test complete (ran on our server)' : `Stress test complete (ran on this device${why})`);
      if (cloud.mayCollect()) {
        const ranOn = r.ranOn === 'server' ? 'server' : 'browser';
        void cloud.store.logSimRun({ kind: 'stress', config, summary: r.result, durationMs: r.durationMs, ranOn });
      }
    })
    .catch((e: unknown) => {
      if (stressAbort !== ac) return;
      stressAbort = null;
      ui.setStress(null);
      ui.toast(`Stress test failed: ${errorMessage(e)}`);
    });
}

// ---------- Per-frame world update ----------

function maxWarpFor(s: Sim | null): number {
  if (!s || s.done) return Infinity;
  return s.state.altitude < WARP_CAP_ALTITUDE || s.state.thrust > 0 ? WARP_CAP_ATMOSPHERE : WARP_CAP_COAST;
}

function originFor(m: CameraMode, state: SimState | null): Vec3 {
  if (m === 'pad' || !state) return [0, R_EARTH + activeConfig.launchAltitude, 0];
  return [state.pos[0], state.pos[1], state.pos[2]];
}

function nozzlePhysical(state: SimState, r: RocketModel): Vec3 {
  return add(state.pos, quatRotate(state.quat, [0, state.cgX - r.length, 0]));
}

function placeRocket(state: SimState | null, origin: Vec3, now: number): void {
  if (!rocketRoot || !rocket || !state) return;
  const q = new THREE.Quaternion(state.quat[0], state.quat[1], state.quat[2], state.quat[3]);
  rocketRoot.quaternion.copy(q);
  const cg = toScene(state.pos, origin);
  const offset = new THREE.Vector3(0, state.cgX, 0).applyQuaternion(q);
  rocketRoot.position.copy(cg).add(offset);
  markers?.update(state.cgX, state.cpX);
  exhaust?.update(state.thrust, motorPeak, rocket.maxRadius, now / 1000);
}

function updateSmokeAndTrail(state: SimState | null, origin: Vec3, simDt: number, realDt: number): void {
  const live = replayT === null && launched && !!rocket && !!state;
  if (live && state && rocket && simDt > 0) {
    if (state.thrust > 0 && state.altitude < SMOKE_ALT_LIMIT) {
      const puff = smokeForThrust(state.thrust, rocket.maxRadius);
      emitAcc += simDt * puff.rate;
      while (emitAcc >= 1) {
        emitAcc -= 1;
        smoke.emit(nozzlePhysical(state, rocket), puff.size);
      }
    }
  }
  if (toggles.trail && sim && launched) {
    trail.setFromLog(sim.log, replayT ?? undefined);
  }
  // In slow motion the smoke slows with the flight.
  smoke.update(simDt > 0 ? Math.min(realDt, simDt) : realDt, origin);
  trail.update(origin);
}

function updateParachute(state: SimState | null, realDt: number): void {
  if (!rocket || !rocketRoot || !state) {
    if (chute) chute.visible = false;
    return;
  }
  if (!state.chuteDeployed) {
    if (chute) chute.visible = false;
    chuteDeployTime = null;
    chuteLandedTime = null;
    return;
  }

  const up = new THREE.Vector3(...state.pos).normalize();

  if (!chute) {
    const p = firstParachute(rocket);
    if (p) {
      chute = buildParachute(p.diameter);
      scene.add(chute);
    }
  }
  if (!chute) return;

  if (chuteDeployTime === null) {
    const deployEv = sim?.events.find((e) => e.type === 'chuteDeploy');
    chuteDeployTime = deployEv ? deployEv.t : state.t;
    const speed0 = len(state.vel);
    if (speed0 > 0.5) {
      chuteDir.set(...state.vel).multiplyScalar(-1 / speed0);
    } else {
      chuteDir.copy(up);
    }
    const windX = -Math.sin(activeConfig.windDirection);
    const windZ = Math.cos(activeConfig.windDirection);
    if (Math.hypot(windX, windZ) > 0.01) {
      chuteSettleAxis.set(windX, 0, windZ).normalize();
    } else {
      const nose = new THREE.Vector3(0, 1, 0).applyQuaternion(rocketRoot.quaternion);
      const horiz = nose.sub(up.clone().multiplyScalar(nose.dot(up)));
      if (horiz.lengthSq() > 1e-4) chuteSettleAxis.copy(horiz.normalize());
      else chuteSettleAxis.set(1, 0, 0);
    }
  }

  chute.visible = true;
  chute.position.copy(rocketRoot.position);

  // Smooth S-curve inflation over 0.6 s after deployment.
  const dtOpen = Math.max(0, state.t - chuteDeployTime);
  const uOpen = Math.min(1, dtOpen / 0.6);
  const inflate = 0.2 + 0.8 * (uOpen * uOpen * (3 - 2 * uOpen));

  if (state.phase === 'landed' || state.phase === 'crashed') {
    if (chuteLandedTime === null) chuteLandedTime = replayT !== null ? 1.4 : 0;
    else if (replayT === null) chuteLandedTime += realDt;
    // Settle and collapse canopy gently toward the ground rather than hovering straight up.
    const uLand = Math.min(1, chuteLandedTime / 1.4);
    const settle = uLand * uLand * (3 - 2 * uLand);

    const restDir = chuteSettleAxis.clone().addScaledVector(up, 0.18).normalize();
    const targetDir = up.clone().lerp(restDir, settle).normalize();
    const alpha = replayT !== null ? 1 : 1 - Math.exp(-6 * Math.max(0.001, realDt));
    chuteDir.lerp(targetDir, alpha).normalize();

    const radialScale = inflate * (1 - 0.15 * settle);
    const axialScale = inflate * (1 - 0.55 * settle);
    chute.scale.set(radialScale, axialScale, radialScale);
  } else {
    chuteLandedTime = null;
    // Blend smoothly between opposite air-relative / descent velocity and local up at low speed.
    const air = windVector(activeConfig, state.altitude, state.t);
    const vx = state.vel[0] - air[0];
    const vy = state.vel[1];
    const vz = state.vel[2] - air[2];
    const vRelSpeed = Math.hypot(vx, vy, vz);

    const velDir = vRelSpeed > 1e-3
      ? new THREE.Vector3(-vx / vRelSpeed, -vy / vRelSpeed, -vz / vRelSpeed)
      : up.clone();
    // Smooth speed blend so canopy never snaps across a hard speed threshold.
    const wVel = Math.min(1, Math.max(0, (vRelSpeed - 0.2) / 1.8));
    const targetDir = up.clone().lerp(velDir, wVel).normalize();

    const alpha = replayT !== null ? 1 : 1 - Math.exp(-10 * Math.max(0.001, realDt));
    chuteDir.lerp(targetDir, alpha).normalize();
    chute.scale.set(inflate, inflate, inflate);
  }

  chute.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), chuteDir);
}

function updateForces(state: SimState | null, origin: Vec3): void {
  arrows.group.visible = toggles.forces;
  if (!toggles.forces || !rocket || !state) return;

  const q: Quat = state.quat;
  const axis = new THREE.Vector3(...quatRotate(q, [0, 1, 0]));
  const thrust = axis.multiplyScalar(state.thrust);

  const speed = len(state.vel);
  const drag = speed > 0
    ? new THREE.Vector3(...state.vel).multiplyScalar(-state.drag / speed)
    : new THREE.Vector3();

  const r = len(state.pos);
  const weightN = state.mass * (MU_EARTH / (r * r));
  const weight = new THREE.Vector3(...state.pos).multiplyScalar(r > 0 ? -weightN / r : 0);
  const scale = weightN > 0 ? rocket.length / weightN : 0;

  const cg = toScene(state.pos, origin);
  const cp = cg.clone().add(new THREE.Vector3(...quatRotate(q, [0, state.cgX - state.cpX, 0])));
  const nozzle = cg.clone().add(
    new THREE.Vector3(...quatRotate(q, [0, state.cgX - rocket.length, 0])),
  );
  arrows.update(
    { thrust, drag, normal: new THREE.Vector3(), weight, scale },
    { cg, cp, nozzle },
  );
}

let starsObj: THREE.Points | undefined;
function updateSky(state: SimState | null, origin: Vec3): void {
  // Sky and stars follow the CAMERA altitude, so the map view sees space.
  const camAlt = Math.hypot(origin[0] + camera.position.x, origin[1] + camera.position.y, origin[2] + camera.position.z) - R_EARTH;
  const altitude = Math.max(state ? state.altitude : 0, camAlt);
  const up = state ? new THREE.Vector3(...state.pos).normalize() : new THREE.Vector3(0, 1, 0);
  sky.update(altitude, solar.sunDirection, up);
  // Stars only show once the sky has thinned out with altitude.
  // The star field is added once its catalogue has loaded; look it up until then, then keep it.
  starsObj ??= solar.group.getObjectByName('Stars') as THREE.Points | undefined;
  const stars = starsObj;
  if (stars) {
    const mat = stars.material as THREE.PointsMaterial;
    mat.transparent = true;
    mat.opacity = Math.min(1, Math.max(0, (altitude - 15_000) / 55_000));
    stars.visible = mat.opacity > 0.01;
  }
}

function updateWorld(state: SimState | null, origin: Vec3, realDt: number, simDt: number, now: number): void {
  // Behind the title screen the sky is only a backdrop: leave the space textures until it is dismissed.
  solar.holdAssets = heroActive;
  solar.update(clock.jd, origin, camera.position);
  site.update(origin, activeConfig.launchAltitude);
  site.group.position.y -= padLift;
  // Sea waves and near-field detail on the terrain around the pad.
  site.updateTerrain?.(now / 1000, Math.max(0, camera.position.y - site.group.position.y));

  placeRocket(state, origin, now);
  updateSmokeAndTrail(state, origin, simDt, realDt);
  updateParachute(state, realDt);
  updateForces(state, origin);
  updateSky(state, origin);
}

function updateCamera(realDt: number, origin: Vec3): void {
  const nose = rocketRoot ? rocketRoot.position : new THREE.Vector3();
  const axis = rocketRoot
    ? new THREE.Vector3(0, 1, 0).applyQuaternion(rocketRoot.quaternion)
    : new THREE.Vector3(0, 1, 0);
  cameraRig.update(realDt, {
    nose,
    up: axis,
    earthCentre: toScene([0, 0, 0], origin),
    groundY: -padLift,
  });
  sky.mesh.position.copy(camera.position);
}

function updateHud(state: SimState | null): void {
  if (sim && sim.events.length !== lastEventCount) {
    lastEventCount = sim.events.length;
    ui.setEvents(sim.events);
  }
  if (!state) return;
  // Show the rate time is really running at, slow motion included.
  const factor = inFlight() && replayT === null ? realisticTimeFactor(sim, clock.warp) : 1;
  ui.setTelemetry(state, Math.round(clock.warp * factor * 100) / 100, clock.paused);
}

// Schedule the next frame first so one exception (a bad sample, a NaN) cannot freeze the app.
let frameErrorLogged = false;
function frame(now: number): void {
  requestAnimationFrame(frame);
  try {
    frameBody(now);
  } catch (e) {
    if (!frameErrorLogged) {
      frameErrorLogged = true;
      console.error('Frame failed; continuing.', e);
    }
  }
}

function frameBody(now: number): void {
  if (document.hidden) {
    lastNow = now;
    return;
  }
  importFix.setVisible(appMode === 'builder' && !heroActive);
  // Under the title overlay the flight scene only needs ~10 fps. lastNow is left alone so the
  // skipped time is still simulated by the next processed frame.
  if (heroActive && appMode === 'flight' && now - lastHeroRenderMs < HERO_FRAME_MS && now >= renderWakeUntil) {
    return;
  }
  const realDt = Math.max(0, (now - lastNow) / 1000);
  lastNow = now;
  const awake = now < renderWakeUntil;

  if (appMode === 'builder') {
    // controls.update() (damping) runs inside render(), so it only needs to run while awake.
    if (awake || builderView.isAnimating?.()) builderView.render(renderer);
    return;
  }

  if (appMode === 'mission') {
    // Draw while time advances or while something recently asked for a redraw; idle and
    // paused (or finished) frames are skipped.
    let draw = awake || missionView.isAnimating();
    // A flight being flown by hand steps its physics here and always needs drawing.
    if (stepPilot(realDt, now)) draw = true;
    if (missionRecord && missionRecord.samples.length > 0) {
      const firstT = missionRecord.samples[0].t;
      const lastT = missionRecord.samples[missionRecord.samples.length - 1].t;
      if (missionPlaying && !pilotFlight) {
        draw = true;
        missionT = Math.min(lastT, missionT + realDt * missionWarp);
        if (missionT >= lastT) {
          missionPlaying = false;
          // Let the breakup fireball and coast line settle after the final step.
          requestRender(2000);
        }
      }
      missionT = Math.max(firstT, Math.min(lastT, missionT));
      if (draw) {
        missionView.setTime(missionT);
        if (now - lastMissionUiMs >= 100) {
          lastMissionUiMs = now;
          missionUi.update(snapshotAt(missionRecord, missionT), missionPlaying, missionWarp);
        }
      }
    }
    if (draw) {
      missionView.render(renderer);
      missionUi.setViewScale(missionView.viewDistance());
    }
    return;
  }

  // Hand flying keeps its own time: its own warp steps, and no automatic slow motion.
  const simDt = manualFlight.active
    ? manualFlight.tick(realDt)
    : clock.tick(realDt * realisticTimeFactor(sim, clock.warp));
  clock.setMaxWarp(maxWarpFor(sim));
  advanceSim(simDt);
  manualFlight.update();

  const state = displayState();
  const origin = originFor(cameraRig.mode, state);
  updateWorld(state, origin, realDt, simDt, now);
  updateCamera(realDt, origin);
  updateHud(state);

  renderer.render(scene, camera);
  if (heroActive) lastHeroRenderMs = now;
}

// ---------- UI wiring ----------

const ui: UI = createUI(app, {
  onFile: (file) => {
    void importFile(file);
  },
  onExport: (format) => {
    void handleExport(format);
  },
  onLoadSample: loadSample,
  onLaunch: launch,
  onReset: () => {
    // While hand flying the control deck has its own reset button.
    if (!manualFlight.active) resetSim();
  },
  onManual: () => startManualFlight(),
  onWarp: (delta) => {
    if (manualFlight.active) manualFlight.warpBy(delta > 0 ? 1 : -1);
    else if (delta > 0) clock.warpUp();
    else clock.warpDown();
  },
  onPause: () => {
    if (manualFlight.active) manualFlight.togglePause();
    else clock.paused = !clock.paused;
  },
  onCamera: (m) => {
    cameraRig.setMode(m, rocket ? rocket.length : 1);
  },
  onConfig: onConfigChanged,
  onMotor: onMotorPicked,
  onToggle: (name, on) => {
    toggles[name] = on;
    if (name === 'cutaway') rebuildRocketVisuals();
    else applyVisibilityToggles();
  },
  onFlawClick: (flaw: Flaw) => {
    if (!sim || !rocket) return;
    const t = flaw.t ?? sim.state.t;
    replayT = t;
    clock.paused = true;
    toggles.forces = true;
    applyVisibilityToggles();
    cameraRig.setMode('chase', rocket.length);
    ui.setReplay(flightDuration, t);
  },
  onStressTest: startStress,
  onScrub: (t) => {
    if (!sim || !sim.done) return;
    replayT = t;
  },
  onBuild: () => enterBuilder(),
  onMission: () => enterMission(),
});

// ---------- Hand flying the main flight ----------

const MANUAL_CAMERAS = ['pad', 'chase', 'onboard', 'map'] as const;
/** The camera chosen in the panels, restored when hand flying ends. */
let cameraBeforeManual: (typeof MANUAL_CAMERAS)[number] = 'pad';

const manualFlight = createManualFlight(app, {
  sim: () => sim,
  launched: () => launched,
  stageCount: () => activeConfig.stageMotors?.length ?? 1,
  noseAxis: () => {
    const axis = new THREE.Vector3(0, 1, 0);
    return rocketRoot ? axis.applyQuaternion(rocketRoot.quaternion) : axis;
  },
  cameraQuaternion: () => camera.quaternion,
  launch: () => {
    launch();
    return launched;
  },
  reset: resetSim,
  cycleCamera: () => {
    const next = MANUAL_CAMERAS[(MANUAL_CAMERAS.indexOf(cameraRig.mode) + 1) % MANUAL_CAMERAS.length];
    cameraRig.setMode(next, rocket ? rocket.length : 1);
  },
  onExit: () => {
    ui.setManual?.(false);
    cameraRig.setMode(cameraBeforeManual, rocket ? rocket.length : 1);
    resetSim();
  },
});

function startManualFlight(): void {
  if (!rocket || !motor) {
    ui.toast(rocket ? 'Pick a motor first' : 'Load a rocket first');
    return;
  }
  cameraBeforeManual = cameraRig.mode;
  ui.setManual?.(true);
  manualFlight.start();
}

// ---------- Build mode glue ----------

let appMode: 'flight' | 'builder' | 'mission' = 'flight';
let builderHistory: History<Design> | null = null;
let builderSelectedId: string | null = null;
let builderCutaway = false;
/** Mirror mode: side parts (fins, strap-on boosters) go on as a left/right pair. */
let builderMirror = false;
let placingPreset: PartPreset | null = null;
let placingSnaps: SnapPoint[] = [];
let hoveredSnapId: string | null = null;
let lastFlightFlaws: Flaw[] = [];

function currentDesign(): Design | null {
  return builderHistory ? builderHistory.present : null;
}

function setDesign(next: Design, commit = true): void {
  if (!builderHistory) {
    builderHistory = createHistory(next);
  } else {
    builderHistory = commit ? pushHistory(builderHistory, next) : replacePresent(builderHistory, next);
  }
  // Editing the design invalidates flaws from an earlier flight.
  lastFlightFlaws = [];
}

const builderView = createBuilderView(renderer.domElement);
// Anything that changes what the builder scene shows also wakes the renderer.
for (const method of ['updateRocket', 'setSnapPoints', 'frameRocket', 'zoomBy', 'setEnabled'] as const) {
  const original = builderView[method].bind(builderView) as (...args: unknown[]) => void;
  (builderView as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
    requestRender();
    original(...args);
  };
}

function computeBuilderStats(model: RocketModel): { stats: BuilderStats; cgX: number; cpX: number } {
  if (model.components.length === 0 || model.length <= 0 || model.maxRadius <= 0) {
    return {
      stats: { length: 0, mass: 0, stabilityCal: NaN, twr: null, motorLabel: null, flaws: [] },
      cgX: 0,
      cpX: 0,
    };
  }
  const ref = findMotorRef(model);
  const m = ref ? findMotor(ref, extraMotors) : null;
  const mp = massProps(model, m, 0);
  const ap = aeroProps(model, 0.1, mp.cgX);
  const stabilityCal = (ap.cpX - mp.cgX) / (2 * model.maxRadius);
  const lift = m && mp.mass > 0 ? takeoffFigures(model, m) : null;
  const preFlaws = preflightFlaws(model, m, stabilityCal).map((s) => s.flaw);
  const flightIds = new Set(lastFlightFlaws.map((f) => f.id));
  const mergedFlaws = [
    ...lastFlightFlaws,
    ...preFlaws.filter((f) => !flightIds.has(f.id)),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    stats: {
      length: model.length,
      mass: lift ? lift.mass : mp.mass,
      stabilityCal,
      twr: lift ? lift.twr : null,
      motorLabel: m ? motorKey(m) : null,
      flaws: mergedFlaws,
    },
    cgX: mp.cgX,
    cpX: ap.cpX,
  };
}

// localStorage-backed lists, re-read only when they change (writers and builder entry).
let cachedSavedDesigns: ReturnType<typeof listSavedDesigns> = [];
let cachedCompletedChallenges: ReturnType<typeof loadCompletedChallenges> = new Set();
function reloadBuilderStorage(): void {
  cachedSavedDesigns = listSavedDesigns();
  cachedCompletedChallenges = loadCompletedChallenges();
}
reloadBuilderStorage();

function refreshBuilder(refitCamera = false, forceInspectorRefresh = false): void {
  const d = currentDesign();
  if (!d || !builderHistory) return;
  requestRender();
  const model = toRocketModel(d);
  const { stats, cgX, cpX } = computeBuilderStats(model);
  builderView.updateRocket({
    rocket: model,
    cutaway: builderCutaway,
    cgX,
    cpX,
    selectedId: builderSelectedId,
    refitCamera,
  });
  builderUi.render({
    design: d,
    selectedId: builderSelectedId,
    stats,
    canUndo: canUndo(builderHistory),
    canRedo: canRedo(builderHistory),
    motors: [...motorChoices().values()],
    savedDesigns: cachedSavedDesigns,
    completedChallenges: cachedCompletedChallenges,
    fits: (preset) => computeSnapPoints(d, preset.create()).some((sn) => sn.diameterMatch),
    forceInspectorRefresh,
  });
}

/** Side-mounted parts become a mirrored left/right pair while Mirror is on. */
function mirrored<T extends Component>(part: T): T {
  if (!builderMirror) return part;
  if (part.kind === 'finset') return { ...part, count: 2 };
  if (part.kind === 'innertube' && (part as InnerTube).radialCount) return { ...part, radialCount: 2 };
  return part;
}

let transitionPromptActive = false;

function clearPlacement(): void {
  placingPreset = null;
  placingSnaps = [];
  hoveredSnapId = null;
  transitionPromptActive = false;
  builderView.setSnapPoints([]);
  builderUi.setPlacing(null, []);
}

function commitSnapPlacement(preset: PartPreset, snap: SnapPoint, addTransition?: boolean): void {
  const base = currentDesign() ?? createEmptyDesign();
  // If diameter mismatches and caller hasn't decided yet, ask whether to insert a transition.
  if (addTransition === undefined && !snap.diameterMatch && snap.needsTransition) {
    transitionPromptActive = true;
    builderUi.setTransitionPrompt({ preset, snap });
    return;
  }
  const part = mirrored(preset.create());
  const res = applySnap(base, part, snap, {
    addTransition: Boolean(addTransition),
    anchor: preset.defaultAnchor,
    offset: preset.defaultOffset,
  });
  if (res) {
    setDesign(res.design, true);
    builderSelectedId = res.id;
    if (preset.placement === 'internal' && part.kind !== 'finset' && !builderCutaway) {
      builderCutaway = true;
      builderUi.setCutaway(true);
    }
  }
  clearPlacement();
  refreshBuilder(false, true);
  if (res) builderView.frameRocket(true);
}

function beginPlacement(preset: PartPreset, immediateIfSingle: boolean): void {
  if (!builderHistory) builderHistory = createHistory(createEmptyDesign());
  const d = builderHistory.present;
  const candidate = preset.create();
  const snaps = computeSnapPoints(d, candidate);
  if (snaps.length === 0) {
    ui.toast(
      preset.placement === 'internal'
        ? 'Add a body tube first to place internal parts'
        : `Cannot place ${preset.label} on this stack`,
    );
    clearPlacement();
    return;
  }
  if (immediateIfSingle && snaps.length === 1 && snaps[0].diameterMatch) {
    commitSnapPlacement(preset, snaps[0], false);
    return;
  }
  placingPreset = preset;
  placingSnaps = snaps;
  hoveredSnapId = null;
  builderView.setSnapPoints(snaps, null);
  builderUi.setPlacing(preset, snaps);
}

const builderUi = createBuilderUI(app, {
  onStartPlace: (preset) => beginPlacement(preset, true),
  onCancelPlace: () => clearPlacement(),
  onChooseSnap: (snap, addTransition) => {
    if (!placingPreset) return;
    commitSnapPlacement(placingPreset, snap, addTransition);
  },
  onDragStartPreset: (preset) => beginPlacement(preset, false),
  onDragEndPreset: () => {
    if (placingPreset && !transitionPromptActive) clearPlacement();
  },
  // While a card is dragged the closest ring lights up, however far away the pointer is,
  // so letting go anywhere over the stage puts the part somewhere sensible.
  onDragMovePreset: (x, y, overStage) => {
    if (!placingPreset) return;
    const hit = overStage ? builderView.pickSnapPoint(x, y, Infinity) : null;
    const nextId = hit?.id ?? null;
    if (nextId !== hoveredSnapId) {
      hoveredSnapId = nextId;
      builderView.setSnapPoints(placingSnaps, hoveredSnapId, placingPreset.create());
    }
    if (hit) builderUi.setDragGhost(`Let go to add: ${hit.label}`);
  },
  onDropPreset: (x, y, overStage) => {
    const preset = placingPreset;
    if (!preset) return;
    const snap = overStage ? builderView.pickSnapPoint(x, y, Infinity) : null;
    if (snap) commitSnapPlacement(preset, snap);
    else clearPlacement();
  },
  onToggleMirror: (on) => {
    builderMirror = on;
    requestRender();
    // Turning Mirror on with fins or boosters selected mirrors those straight away.
    const d = currentDesign();
    const found = on && d && builderSelectedId ? findPart(d, builderSelectedId) : null;
    if (d && found) {
      const next = mirrored(found.part);
      if (next !== found.part) {
        const patch = found.part.kind === 'finset' ? { count: 2 } : { radialCount: 2 };
        setDesign(updatePart(d, found.part.id, { part: patch as Partial<Component> }), true);
        refreshBuilder(false, true);
      }
    }
    ui.toast(on ? 'Mirror on: fins and boosters go on as a left-and-right pair' : 'Mirror off');
  },
  onZoom: (factor) => builderView.zoomBy(factor),
  onSelectPart: (partId) => {
    builderSelectedId = partId;
    if (partId) {
      const d = currentDesign();
      const found = d ? findPart(d, partId) : null;
      if (found && found.parentId !== null && found.part.kind !== 'finset' && !builderCutaway) {
        builderCutaway = true;
        builderUi.setCutaway(true);
      }
    }
    refreshBuilder(false, true);
  },
  onUpdatePart: (partId, patch, commit) => {
    const d = currentDesign();
    if (!d) return;
    const next = updatePart(d, partId, patch);
    setDesign(next, commit);
    refreshBuilder(false, false);
  },
  onMovePart: (partId, delta) => {
    const d = currentDesign();
    if (!d) return;
    const found = findPart(d, partId);
    if (!found || found.parentId !== null) return;
    const next = moveExternalPart(d, partId, found.stackIndex + delta);
    if (next !== d) {
      setDesign(next, true);
      refreshBuilder(false, true);
    }
  },
  onDuplicatePart: (partId) => {
    const d = currentDesign();
    if (!d) return;
    const res = duplicatePart(d, partId);
    if (res) {
      setDesign(res.design, true);
      builderSelectedId = res.id;
      refreshBuilder(false, true);
    }
  },
  onDeletePart: (partId) => {
    const d = currentDesign();
    if (!d) return;
    setDesign(removePart(d, partId), true);
    if (builderSelectedId === partId) builderSelectedId = null;
    clearPlacement();
    refreshBuilder(false, true);
    builderView.frameRocket(true);
  },
  onUndo: () => {
    if (!builderHistory || !canUndo(builderHistory)) return;
    builderHistory = undoHistory(builderHistory);
    lastFlightFlaws = [];
    if (builderSelectedId && !findPart(builderHistory.present, builderSelectedId)) {
      builderSelectedId = null;
    }
    clearPlacement();
    refreshBuilder(false, true);
  },
  onRedo: () => {
    if (!builderHistory || !canRedo(builderHistory)) return;
    builderHistory = redoHistory(builderHistory);
    lastFlightFlaws = [];
    if (builderSelectedId && !findPart(builderHistory.present, builderSelectedId)) {
      builderSelectedId = null;
    }
    clearPlacement();
    refreshBuilder(false, true);
  },
  onRename: (name) => {
    const d = currentDesign();
    if (!d) return;
    setDesign({ ...d, name }, true);
    refreshBuilder(false, false);
  },
  onClear: () => {
    setDesign(createEmptyDesign('New Rocket'), true);
    builderSelectedId = null;
    clearPlacement();
    refreshBuilder(true, true);
  },
  onToggleCutaway: (on) => {
    builderCutaway = on;
    requestRender();
    refreshBuilder(false, false);
  },
  onFrameCamera: () => builderView.frameRocket(),
  onGoToPad: () => exitBuilderToPad(),
  onMission: () => enterMission(),
  onSaveDesign: () => {
    const d = currentDesign();
    if (!d) return;
    const thumb = builderView.captureThumbnail(renderer);
    try {
      saveDesign(d, thumb);
    } catch (e) {
      ui.toast(`Could not save: ${errorMessage(e)}`);
      return;
    }
    reloadBuilderStorage();
    ui.toast(`Saved "${d.name}"`);
    refreshBuilder(false, false);
    void cloudReady.then((cloud) => pushDesign(cloud, d, thumb, importFix.sourceSha())).catch((e) => console.warn('Cloud save skipped:', e));
  },
  onLoadSavedDesign: (design) => {
    importSeq++;
    importFix.clear();
    builderHistory = createHistory(design);
    builderSelectedId = null;
    lastFlightFlaws = [];
    clearPlacement();
    refreshBuilder(true, true);
    ui.toast(`Loaded "${design.name}"`);
  },
  onDeleteSavedDesign: (id) => {
    void cloudReady.then((cloud) => removeDesign(cloud, id)).catch((e) => console.warn('Cloud delete skipped:', e));
    deleteSavedDesign(id);
    reloadBuilderStorage();
    refreshBuilder(false, false);
  },
  onExport: (format) => {
    void handleExport(format);
  },
  onCopyShareLink: () => {
    void handleCopyShareLink();
  },
  onImportFile: (file) => {
    void importFile(file);
  },
});

/** The builder's design while building, the pad rocket otherwise; either falls back to the other. */
function exportSourceDesign(): Design | null {
  const padDesign = () => (rocket ? fromRocketModel(rocket) : null);
  return appMode === 'builder' ? (currentDesign() ?? padDesign()) : (padDesign() ?? currentDesign());
}

async function handleExport(format: ExportFormat): Promise<void> {
  const d = exportSourceDesign();
  if (!d || d.stack.length === 0) {
    ui.toast('Load or build a rocket first');
    return;
  }
  try {
    const { blob, filename } = await exportDesign(d, format);
    const how = await saveBlob(blob, filename);
    if (how !== 'cancelled') {
      ui.toast(`Exported ${filename}`);
    }
  } catch (e) {
    ui.toast(`Export failed: ${errorMessage(e)}`);
  }
}

async function handleCopyShareLink(): Promise<void> {
  const d = exportSourceDesign();
  if (!d || d.stack.length === 0) {
    ui.toast('Build or load a rocket first');
    return;
  }
  try {
    // Inside the Android app the page is https://localhost; links must point at the website.
    const baseUrl = shareBaseUrl();
    const url = await buildShareUrl(d, baseUrl);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    ui.toast('Copied share link');
  } catch (e) {
    ui.toast(`Could not copy share link: ${errorMessage(e)}`);
  }
}

function enterBuilder(): void {
  if (manualFlight.active) manualFlight.exit();
  if (!builderHistory) {
    const initial = rocket ? fromRocketModel(rocket) : createEmptyDesign();
    builderHistory = createHistory(initial);
  }
  reloadBuilderStorage();
  appMode = 'builder';
  requestRender();
  cameraRig.setEnabled(false);
  builderView.setEnabled(true);
  ui.setVisible(false);
  builderUi.setVisible(true);
  refreshBuilder(true, true);
}

function exitBuilderToPad(): void {
  const d = currentDesign();
  if (!d || d.stack.length === 0) {
    ui.toast('Add at least a nose cone and body tube first');
    return;
  }
  const model = toRocketModel(d);
  // The builder's rocket is going to the pad: an import still loading must not replace it.
  importSeq++;
  appMode = 'flight';
  requestRender();
  clearPlacement();
  builderView.setEnabled(false);
  cameraRig.setEnabled(true);
  builderUi.setVisible(false);
  ui.setVisible(true);
  ui.setBuildLabel?.('Back to Builder');
  loadRocket(model);
}

// The 3D stage in builder mode:
//  - click a glowing ring while placing     -> the part goes there
//  - click a part                           -> select it
//  - drag an outside part (nose, tube, ...) -> rings show where it can go; let go to move it
//  - drag an inside/side part (fins, ...)   -> slides it up and down its tube
//  - drag empty space                       -> turn the camera (OrbitControls)
interface StagePartDrag {
  id: string;
  kind: 'reorder' | 'slide';
  startX: number;
  startY: number;
  active: boolean;
  startOffset: number;
  /** Slide range in metres: at least the parent tube length either way, and always holds startOffset. */
  minOffset: number;
  maxOffset: number;
  name: string;
  /** True once the first slide tick has pushed its undo step; later ticks replace it. */
  committed: boolean;
  /** Latest unapplied slide offset, applied once per animation frame. */
  pendingOffset: number | null;
  frame: number;
}
let builderDownPos: { x: number; y: number } | null = null;
let stagePartDrag: StagePartDrag | null = null;
let moveTargets: SnapPoint[] = [];
let hoveredMoveId: string | null = null;

/** Rings at every joint the dragged stack part could move to (its own two joints excluded). */
function computeMoveTargets(d: Design, partId: string): SnapPoint[] {
  const from = d.stack.findIndex((n) => n.id === partId);
  if (from === -1) return [];
  const out: SnapPoint[] = [];
  let station = 0;
  for (let b = 0; b <= d.stack.length; b++) {
    if (b !== from && b !== from + 1) {
      const above = b > 0 ? d.stack[b - 1].part : null;
      const below = b < d.stack.length ? d.stack[b].part : null;
      const label =
        b === 0 ? 'top of the rocket' : b === d.stack.length ? 'bottom of the rocket' : `spot below the ${friendlyName(above!.name)}`;
      const radius = Math.max(
        above ? aftRadiusOf(above as ExternalComponent) : 0,
        below ? foreRadiusOf(below as ExternalComponent) : 0,
        0.008,
      );
      out.push({
        id: `move-${b}`,
        kind: b === 0 ? 'top' : b === d.stack.length ? 'bottom' : 'between',
        label,
        stationX: station,
        radius,
        // Index after the part is lifted out of the stack.
        insertIndex: b > from ? b - 1 : b,
        diameterMatch: true,
      });
    }
    if (b < d.stack.length) station += d.stack[b].part.length;
  }
  return out;
}

/** Applies the latest pending slide offset (if any) and cancels the scheduled frame. */
function flushSlideDrag(drag: StagePartDrag): void {
  if (drag.frame) {
    cancelAnimationFrame(drag.frame);
    drag.frame = 0;
  }
  if (drag.pendingOffset === null) return;
  const offset = drag.pendingOffset;
  drag.pendingOffset = null;
  const d = currentDesign();
  if (!d) return;
  // One undo step per drag: the first tick commits, the rest replace it.
  setDesign(updatePart(d, drag.id, { offset }), !drag.committed);
  drag.committed = true;
  refreshBuilder(false, false);
}

function endStagePartDrag(): void {
  const drag = stagePartDrag;
  if (drag?.kind === 'slide') {
    flushSlideDrag(drag);
    // The inspector was left alone during the drag: show the final value now.
    if (drag.committed && appMode === 'builder') refreshBuilder(false, true);
  }
  stagePartDrag = null;
  moveTargets = [];
  hoveredMoveId = null;
  builderUi.setDragGhost(null);
  renderer.domElement.style.cursor = '';
  if (appMode === 'builder') {
    builderView.setEnabled(true);
    if (!placingPreset) builderView.setSnapPoints([]);
  }
}

// Capture phase: this runs before OrbitControls' own pointerdown, so a press that lands on
// a part can switch the camera off for the length of the drag.
renderer.domElement.addEventListener(
  'pointerdown',
  (e) => {
    if (appMode !== 'builder') return;
    builderDownPos = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || placingPreset || e.pointerType === 'touch') return;
    const d = currentDesign();
    const hitId = builderView.pickPart(e.clientX, e.clientY);
    const found = d && hitId ? findPart(d, hitId) : null;
    if (!d || !found) return;
    const reorder = found.parentId === null;
    if (reorder && d.stack.length < 2) return;
    const startOffset = found.offset ?? 0;
    const parent = found.parentId ? findPart(d, found.parentId) : null;
    const reach = Math.max(0.3, parent?.part.length ?? 0);
    stagePartDrag = {
      id: found.part.id,
      kind: reorder ? 'reorder' : 'slide',
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      startOffset,
      minOffset: Math.min(-reach, startOffset),
      maxOffset: Math.max(reach, startOffset),
      name: friendlyName(found.part.name),
      committed: false,
      pendingOffset: null,
      frame: 0,
    };
    builderView.setEnabled(false);
    try {
      renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable: the drag still works while the pointer stays over the stage */
    }
  },
  { capture: true },
);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (appMode !== 'builder') return;
  const drag = stagePartDrag;
  if (drag) {
    const d = currentDesign();
    if (!d) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 8) return;
      drag.active = true;
      renderer.domElement.style.cursor = 'grabbing';
      if (builderSelectedId !== drag.id) {
        builderSelectedId = drag.id;
        refreshBuilder(false, true);
      }
      if (drag.kind === 'reorder') {
        moveTargets = computeMoveTargets(d, drag.id);
        hoveredMoveId = null;
        builderView.setSnapPoints(moveTargets, null);
      }
    }
    if (drag.kind === 'reorder') {
      const hit = builderView.pickSnapPoint(e.clientX, e.clientY, Infinity);
      const nextId = hit?.id ?? null;
      if (nextId !== hoveredMoveId) {
        hoveredMoveId = nextId;
        builderView.setSnapPoints(moveTargets, hoveredMoveId);
      }
      builderUi.setDragGhost(hit ? `Move ${drag.name} to the ${hit.label}` : `Move ${drag.name}`, e.clientX, e.clientY);
    } else {
      // Down the screen is toward the tail, which is a positive offset.
      const metres = (e.clientY - drag.startY) * builderView.metersPerPixel();
      const offset = Math.max(drag.minOffset, Math.min(drag.maxOffset, Number((drag.startOffset + metres).toFixed(4))));
      // Rebuilding the model and mesh is costly: apply at most once per frame.
      drag.pendingOffset = offset;
      if (!drag.frame) {
        drag.frame = requestAnimationFrame(() => {
          drag.frame = 0;
          if (stagePartDrag === drag) flushSlideDrag(drag);
        });
      }
      builderUi.setDragGhost(`Slide ${drag.name}: ${(offset * 100).toFixed(1)} cm`, e.clientX, e.clientY);
    }
    return;
  }
  if (!placingPreset || placingSnaps.length === 0) return;
  const hit = builderView.pickSnapPoint(e.clientX, e.clientY);
  const nextId = hit?.id ?? null;
  if (nextId !== hoveredSnapId) {
    hoveredSnapId = nextId;
    builderView.setSnapPoints(placingSnaps, hoveredSnapId, placingPreset.create());
  }
  renderer.domElement.style.cursor = hit ? 'pointer' : '';
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (appMode !== 'builder') return;
  const drag = stagePartDrag;
  if (drag?.active) {
    const d = currentDesign();
    const target =
      drag.kind === 'reorder' ? moveTargets.find((t) => t.id === hoveredMoveId) ?? null : null;
    endStagePartDrag();
    builderDownPos = null;
    if (d && target && target.insertIndex !== undefined) {
      const next = moveExternalPart(d, drag.id, target.insertIndex);
      if (next !== d) {
        setDesign(next, true);
        refreshBuilder(false, true);
      }
    }
    return;
  }
  if (drag) endStagePartDrag();
  if (!builderDownPos) return;
  const dist = Math.hypot(e.clientX - builderDownPos.x, e.clientY - builderDownPos.y);
  builderDownPos = null;
  if (dist > 8) return;
  if (placingPreset && placingSnaps.length > 0) {
    const snap = builderView.pickSnapPoint(e.clientX, e.clientY);
    if (snap) {
      commitSnapPlacement(placingPreset, snap);
      return;
    }
  }
  const hit = builderView.pickPart(e.clientX, e.clientY);
  if (hit !== builderSelectedId) {
    builderSelectedId = hit;
    refreshBuilder(false, true);
  }
});

renderer.domElement.addEventListener('pointercancel', () => {
  if (stagePartDrag) endStagePartDrag();
  builderDownPos = null;
});

activeConfig = ui.getConfig();

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  builderView.resize(w, h);
  missionView.resize(w, h);
  renderer.setPixelRatio(targetPixelRatio());
  renderer.setSize(w, h);
  requestRender();
});

// ---------- Mission mode glue ----------

const DEFAULT_MISSION_ID = 'lvm3-m4';
// The mission now being shown. Changed by selectMission().
let missionDef: MissionDef = getMission(DEFAULT_MISSION_ID)!;
const missionView = createMissionView(renderer.domElement);
// Keyed by `${missionId}:${caseId}` so two missions never share a flight.
const missionCache = new Map<string, FlightRecord>();
// Bumped on every load; a load that is no longer the latest does not touch the UI.
let missionLoadSeq = 0;
const SCENARIO_IDS = new Set<string>(['blocked-vent', 'regulator-low', 'hot-grain']);
let missionRecord: FlightRecord | null = null;
let missionT = 0;
let missionPlaying = true;
let missionWarp = 1;
let lastMissionUiMs = -Infinity;

// ---------- Piloted flight: the mission flown live, by hand ----------

let pilotFlight: PilotedFlight | null = null;
let pilotMarkerVersion = -1;
let lastPilotPathMs = -Infinity;
/** Live flights step the physics every frame, so the top replay speed is not offered. */
const PILOT_MAX_WARP = 20;

function startPilot(): void {
  // A replay still loading must not land on top of the live flight.
  missionLoadSeq++;
  missionLoadAbort?.abort();
  missionLoadAbort = null;
  missionUi.setBusy(null);
  let flight: PilotedFlight;
  try {
    flight = startPilotedFlight(missionDef);
  } catch (e) {
    missionUi.setError(`Could not start the flight: ${errorMessage(e)}`);
    return;
  }
  applyMissionRecord(flight.record);
  pilotFlight = flight;
  pilotMarkerVersion = flight.markerVersion;
  lastPilotPathMs = -Infinity;
  missionWarp = 1;
  pilotControls.setFlight(flight);
  pilotControls.update();
}

/** Stop flying and leave the flight so far on screen as an ordinary replay. */
function endPilot(): void {
  const flight = pilotFlight;
  if (!flight) return;
  const record = flight.finish();
  applyMissionRecord(record);
  missionT = record.samples[record.samples.length - 1].t;
  missionPlaying = false;
  missionView.setTime(missionT);
  missionUi.update(snapshotAt(record, missionT), missionPlaying, missionWarp);
  requestRender(2000);
}

/** Advances a live flight by one frame. Returns true while one is running. */
function stepPilot(realDt: number, now: number): boolean {
  const flight = pilotFlight;
  if (!flight) return false;
  if (missionPlaying && !flight.ended) {
    // A stalled tab must not turn into one enormous physics step.
    flight.advance(Math.min(realDt, 0.1) * Math.min(missionWarp, PILOT_MAX_WARP));
  }
  const samples = flight.record.samples;
  missionT = samples[samples.length - 1].t;
  if (now - lastPilotPathMs >= 500) {
    lastPilotPathMs = now;
    missionView.refreshPath();
  }
  if (flight.markerVersion !== pilotMarkerVersion) {
    pilotMarkerVersion = flight.markerVersion;
    missionUi.setRecord(flight.record, missionDef);
  }
  pilotControls.update();
  if (flight.ended) endPilot();
  return true;
}

function applyMissionRecord(record: FlightRecord): void {
  // Showing any flight, including a finished live one as a replay, ends live flying.
  if (pilotFlight) {
    pilotFlight = null;
    pilotControls.setFlight(null);
  }
  requestRender();
  missionRecord = record;
  missionT = record.samples[0]?.t ?? 0;
  missionPlaying = true;
  missionView.setRecord(record, missionDef);
  missionUi.setRecord(record, missionDef);
  missionUi.setError(null);
  if (record.samples.length > 0) {
    lastMissionUiMs = performance.now();
    missionUi.update(snapshotAt(record, missionT), missionPlaying, missionWarp);
  }
}

const MISSION_CACHE_MAX = 8;
// Map order is recency order: a hit re-inserts, and the oldest entry is evicted past the cap.
function cacheMissionRecord(key: string, rec: FlightRecord): void {
  missionCache.delete(key);
  missionCache.set(key, rec);
  while (missionCache.size > MISSION_CACHE_MAX) {
    missionCache.delete(missionCache.keys().next().value as string);
  }
}
// The in-flight flight computation; aborted (worker terminated) when a newer load starts.
let missionLoadAbort: AbortController | null = null;

const MISSION_NOTE_MS = 8000;
let missionNoteTimer = 0;
/**
 * Mission mode hides the toasts and its error banner is for failures, so a short notice borrows
 * the header line that describes the chosen case, then gives it back.
 */
function showMissionNote(text: string): void {
  const line = document.querySelector<HTMLElement>('.msn-case-note');
  if (!line) return;
  const before = line.textContent;
  window.clearTimeout(missionNoteTimer);
  line.textContent = text;
  missionNoteTimer = window.setTimeout(() => {
    // Another case or mission may have written its own description since.
    if (line.textContent === text) line.textContent = before;
  }, MISSION_NOTE_MS);
}

async function loadMissionCase(caseId: string): Promise<void> {
  const def = missionDef;
  const seq = ++missionLoadSeq;
  missionLoadAbort?.abort();
  missionLoadAbort = null;
  const key = `${def.id}:${caseId}`;
  const cached = missionCache.get(key);
  if (cached) {
    cacheMissionRecord(key, cached);
    missionUi.setBusy(null);
    applyMissionRecord(cached);
    return;
  }
  missionUi.setError(null);
  missionUi.setBusy('Computing flight…');
  const opts: FlyOptions =
    caseId === 'nominal'
      ? {}
      : SCENARIO_IDS.has(caseId)
        ? { scenario: caseId as ScenarioId, destructive: true }
        : { failureCase: caseId, destructive: true };
  const controller = new AbortController();
  missionLoadAbort = controller;
  try {
    const { record: rec, fallbackReason } = await runMissionFlight(def.id, opts, { signal: controller.signal });
    cacheMissionRecord(key, rec);
    if (seq === missionLoadSeq && appMode === 'mission') {
      applyMissionRecord(rec);
      // A replay from the cache does not come through here, so each computed flight says it once.
      if (fallbackReason) showMissionNote(`Computed on this device: ${fallbackReason}.`);
    }
  } catch (e) {
    if (isAbortError(e)) return;
    if (seq === missionLoadSeq) missionUi.setError(`Mission failed: ${errorMessage(e)}`);
  } finally {
    if (seq === missionLoadSeq) {
      missionUi.setBusy(null);
      if (missionLoadAbort === controller) missionLoadAbort = null;
    }
  }
}

/** Throws away a live flight: it belongs to the mission or the screen being left. */
function dropPilot(): void {
  if (!pilotFlight) return;
  pilotFlight = null;
  pilotControls.setFlight(null);
  // Its unfinished record is no replay; entering mission mode again loads a fresh flight.
  missionRecord = null;
}

/** Switches to another mission and loads its nominal flight. Unknown ids are ignored. */
function selectMission(id: string): void {
  const def = getMission(id);
  if (!def) return;
  dropPilot();
  requestRender();
  missionDef = def;
  missionRecord = null;
  missionT = 0;
  missionPlaying = true;
  void loadMissionCase('nominal');
}

const missionUi = createMissionUI(app, {
  onExit: () => exitMission(),
  onMission: (id) => selectMission(id),
  onFly: (caseId) => {
    void loadMissionCase(caseId);
  },
  onPlayPause: () => {
    requestRender();
    missionPlaying = !missionPlaying;
    if (missionRecord && missionRecord.samples.length > 0) {
      missionUi.update(snapshotAt(missionRecord, missionT), missionPlaying, missionWarp);
    }
  },
  onWarp: (warp) => {
    requestRender();
    missionWarp = warp;
    if (missionRecord && missionRecord.samples.length > 0) {
      missionUi.update(snapshotAt(missionRecord, missionT), missionPlaying, missionWarp);
    }
  },
  onScrub: (t) => {
    if (!missionRecord || missionRecord.samples.length === 0) return;
    requestRender();
    missionT = t;
    missionPlaying = false;
    missionView.setTime(missionT);
    missionUi.update(snapshotAt(missionRecord, missionT), missionPlaying, missionWarp);
  },
  onCamera: (mode) => {
    requestRender();
    missionView.setCamera(mode);
  },
});

const pilotControls = createPilotControls(app.querySelector<HTMLElement>('.msn-root')!, {
  onStart: () => startPilot(),
  onEnd: () => endPilot(),
});

function enterMission(id?: string): void {
  if (manualFlight.active) manualFlight.exit();
  logUsage('mission');
  appMode = 'mission';
  heroActive = false;
  requestRender();
  cameraRig.setEnabled(false);
  builderView.setEnabled(false);
  ui.setVisible(false);
  builderUi.setVisible(false);
  missionUi.setVisible(true);
  missionView.setEnabled(true);
  if (id !== undefined && id !== missionDef.id && getMission(id)) {
    selectMission(id);
  } else if (!missionRecord) {
    void loadMissionCase('nominal');
  }
}

function exitMission(): void {
  // Nothing should keep computing a flight nobody is looking at.
  missionLoadAbort?.abort();
  missionLoadAbort = null;
  missionUi.setBusy(null);
  dropPilot();
  appMode = 'flight';
  requestRender();
  missionView.setEnabled(false);
  missionUi.setVisible(false);
  ui.setVisible(true);
  cameraRig.setEnabled(true);
}

// Debug hook for the browser console.
interface DebugHook {
  readonly sim: Sim | null;
  readonly rocket: RocketModel | null;
  readonly clock: SimClock;
  /** Last completed stress test, or null. */
  readonly stress: StressReport | null;
}
(window as Window & { __sfb?: DebugHook }).__sfb = {
  get sim() {
    return sim;
  },
  get rocket() {
    return rocket;
  },
  get stress() {
    return lastStress;
  },
  clock,
};

async function tryLoadSharedRocket(): Promise<void> {
  const hash = window.location.hash;
  if (!hash.includes(`${SHARE_HASH_KEY}=`)) return;
  try {
    const design = await decodeDesignFromHash(hash);
    if (!design) {
      ui.toast('That shared rocket link is not valid, so it was not loaded.');
      return;
    }
    const model = toRocketModel(design);
    loadImportedDesign(design, model);
    ui.toast('Loaded shared rocket');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch (e) {
    ui.toast(`Could not load shared rocket: ${errorMessage(e)}`);
  }
}

loadSample();
void tryLoadSharedRocket();
// Rockets saved to the account on another device join this browser's list.
void cloudReady
  .then(pullDesigns)
  .then((added) => {
    if (added === 0) return;
    reloadBuilderStorage();
    if (appMode === 'builder') refreshBuilder(false, false);
    ui.toast(`${added} rocket${added === 1 ? '' : 's'} from your account added to Save / Open`);
  })
  .catch((e) => console.warn('Cloud sync skipped:', e));
requestAnimationFrame(frame);

// Someone who picked a flyable mission on the landing page goes straight to mission mode;
// someone who just signed up or signed in goes straight to build mode.
// Everyone else gets the title screen, once per browser session (returning from the Moon
// page skips it).
const PRESET_MISSIONS = new Map<string, string>([
  ['chandrayaan-3', 'lvm3-m4'],
  ['starlink', 'falcon9-starlink'],
  ['eos-09', 'pslv-c61'],
]);
const selectedPreset = takeSelectedPreset();
const presetMissionId = selectedPreset === null ? undefined : PRESET_MISSIONS.get(selectedPreset);
const enterBuild = takeEnterBuildFlag();
if (presetMissionId !== undefined) {
  // Falls back to the default mission while a mission definition is not merged yet.
  enterMission(getMission(presetMissionId) ? presetMissionId : DEFAULT_MISSION_ID);
} else if (enterBuild) {
  enterBuilder();
} else {
  const hero = mountHero(app, {
    onBuild: () => {
      heroActive = false;
      enterBuilder();
    },
    onFly: () => {
      heroActive = false;
      requestRender();
    },
    onMoon: () => window.location.assign('./landing.html'),
    onMission: () => {
      heroActive = false;
      enterMission();
    },
  });
  heroActive = hero !== null;
}

/** Preset mission chosen on the landing page (set in src/auth/gate.ts). */
function takeSelectedPreset(): string | null {
  try {
    const preset = window.sessionStorage.getItem('astra-preset');
    window.sessionStorage.removeItem('astra-preset');
    return preset;
  } catch {
    return null;
  }
}

/** True once after a sign-in through the landing page (the flag is set in src/app/boot.ts). */
function takeEnterBuildFlag(): boolean {
  try {
    const set = window.sessionStorage.getItem('astra-enter-build') !== null;
    window.sessionStorage.removeItem('astra-enter-build');
    return set;
  } catch {
    return false;
  }
}

// Debug hook to fly a mission from the browser console.
interface MissionDebugHook {
  astraRunMission?: (id?: string) => Promise<unknown>;
}
if ((import.meta.env as { DEV?: boolean }).DEV) {
  (window as Window & MissionDebugHook).astraRunMission = (id = 'lvm3-m4') =>
    runMission(id);
}

// Dev-only hook for inspecting the mission view from the console:
// __astraMission.cam('solar'), __astraMission.seek(120), __astraMission.capture() -> JPEG data URL.
if ((import.meta.env as { DEV?: boolean }).DEV) {
  (window as Window & { __astraMission?: unknown }).__astraMission = {
    cam: (mode: Parameters<typeof missionView.setCamera>[0]) => {
      missionView.setCamera(mode);
      requestRender(3000);
    },
    seek: (t: number) => {
      missionT = t;
      missionPlaying = false;
      missionView.setTime(t);
      requestRender(1000);
    },
    capture: (quality = 0.8): string => {
      missionView.render(renderer);
      return renderer.domElement.toDataURL('image/jpeg', quality);
    },
    view: missionView,
  };
}
