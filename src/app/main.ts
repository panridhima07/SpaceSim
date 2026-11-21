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
import { stressTestSteps, type StressProgress } from '../physics/sweep';
import { atmosphere } from '../physics/atmosphere';
import { massProps } from '../physics/massprops';
import { aeroProps } from '../physics/aero';
import { add, quatRotate, len } from '../physics/vec';
import { parseOrkXml } from '../ork/parser';
import { readOrkZip } from '../ork/orkExtras';
import { embeddedMotors } from '../ork/rse';
import { fetchMotorFromThrustCurve } from '../ork/thrustcurve';
import { SAMPLE_ORK_XML } from '../ork/sample';
import { ALL_MOTORS, findMotor, parseEng, thrustAt } from '../ork/motors';
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
} from '../render/effects';
import { buildSolarSystem } from '../world/solarSystem';
import { buildLaunchSite } from '../world/launchSite';
import { SimClock } from '../world/clock';
import { createUI } from './ui';
import { mountHero } from './hero';
import { createCameraRig, type CameraRig } from './cameras';
import type { CameraMode, ToggleName, UI } from './uiTypes';
import {
  createEmptyDesign,
  duplicatePart,
  findPart,
  fromRocketModel,
  moveExternalPart,
  removePart,
  toRocketModel,
  updatePart,
  type Design,
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
  exportDesignJson,
  importDesignJson,
  listSavedDesigns,
  saveDesign,
} from '../builder/storage';
import { exportOrkZip } from '../builder/orkExport';
import { saveBlob } from './saveFile';
import {
  evaluateChallenges,
  loadCompletedChallenges,
  markChallengesCompleted,
} from '../builder/challenges';
import { createBuilderView } from '../builder/view';
import { createBuilderUI, type BuilderStats } from './builderUi';

type Markers = ReturnType<typeof buildCgCpMarkers>;
type Exhaust = ReturnType<typeof buildExhaust>;

const PHYSICS_DEPS = cachedDeps({ atmosphere, massProps, aeroProps, thrust: thrustAt });
const STRESS_FRAME_BUDGET_MS = 12; // ms of stress-test work per animation frame
const TWR_TARGET = 5; // peak thrust-to-weight wanted before the rocket leaves the rail
const SEVERITY_RANK: Record<Flaw['severity'], number> = { critical: 0, warning: 1, info: 2 };
const SMOKE_ALT_LIMIT = 30_000; // m, no exhaust puffs above this
const SMOKE_PUFFS_PER_SIM_S = 40;
const TRAIL_INTERVAL_S = 0.05; // 20 Hz of sim time
const WARP_CAP_ATMOSPHERE = 10;
const WARP_CAP_ALTITUDE = 100_000; // m

// ---------- Renderer, scene and fixed world objects ----------

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app element');

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
let stressGen: Generator<StressProgress, StressReport, undefined> | null = null;
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

let lastNow = performance.now();

// ---------- Helpers ----------

function errorMessage(e: unknown): string {
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
  mass: number,
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

  const twr = peakThrust(m) / (mass * G0);
  if (twr < TWR_TARGET) {
    out.push({
      flaw: {
        id: 'static-twr',
        severity: 'warning',
        title: 'Low thrust-to-weight',
        detail: `Peak thrust-to-weight is ${twr.toFixed(2)} with this motor, below the target of ${TWR_TARGET}, so the rocket will be slow off the rail.`,
        fix: 'Use a higher-thrust motor or reduce mass.',
        value: twr,
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
  const stabilityCal = (ap.cpX - mp.cgX) / (2 * rocket.maxRadius);
  ui.setRocket({
    name: rocket.name,
    length: rocket.length,
    diameter: 2 * rocket.maxRadius,
    mass: mp.mass,
    stabilityCal,
    motor: motor ? motorKey(motor) : null,
    warnings: rocket.warnings,
    parts: gradeRocket(rocket).filter((g) => g.external).map((g) => ({
      name: g.name,
      label: PART_LABELS[g.key],
      tier: g.tier,
      icon: PART_ICONS[g.key][g.tier],
      reasons: g.reasons.map((r) => r.text),
    })),
  });
  staticFlaws = preflightFlaws(rocket, motor, mp.mass, stabilityCal);
}

/** Choose a motor (or none), then refresh the lists and reset the flight. */
function applyMotor(m: Motor | null): void {
  clearStress();
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

function loadSample(): void {
  try {
    loadRocket(parseOrkXml(SAMPLE_ORK_XML));
  } catch (e) {
    ui.toast(`Could not load sample: ${errorMessage(e)}`);
  }
}

async function loadFile(file: File): Promise<void> {
  try {
    if (/\.eng$/i.test(file.name)) {
      const parsed = parseEng(await file.text());
      if (parsed.length === 0) {
        ui.toast(`No motors found in ${file.name}`);
        return;
      }
      extraMotors = [...extraMotors, ...parsed];
      ui.toast(`Added ${parsed.length} motor(s) from ${file.name}`);
      if (rocket && !motor) {
        const found = resolveMotorFromRef();
        if (found) applyMotor(found);
      } else {
        refreshMotorList();
      }
      return;
    }
    const { xml, files } = await readOrkZip(await file.arrayBuffer());
    const model = parseOrkXml(xml);
    adoptEmbeddedMotors(embeddedMotors(files));
    // Sync imported .ork into the builder so it can be edited immediately.
    builderHistory = createHistory(fromRocketModel(model));
    builderSelectedId = null;
    lastFlightFlaws = [];
    loadRocket(model);
    if (appMode === 'builder') refreshBuilder(true, true);
  } catch (e) {
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

function resetSim(): void {
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
  if (launched) return;
  if (sim.done) {
    ui.toast('Flight is over - press Reset to fly again');
    return;
  }
  sim.ignite();
  launched = true;
}

function onConfigChanged(): void {
  clearStress();
  if (inFlight()) {
    ui.toast('Reset to apply');
    return;
  }
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
  ui.toast(`${outcome}. Apogee ${Math.round(apogee)} m, flight ${flightDuration.toFixed(1)} s.`);

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
    ui.toast(`Challenge complete: ${newlyCompleted[0].title}!`);
  }
}

function advanceSim(simDt: number): void {
  if (!sim || !inFlight() || replayT !== null) return;
  sim.step(simDt);
  if (sim.done && !finishHandled) onFlightDone();
}

// ---------- Stress test ----------

function clearStress(): void {
  stressGen = null;
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
  if (stressGen) return;
  lastStress = null;
  stressGen = stressTestSteps(rocket, motor, ui.getConfig(), PHYSICS_DEPS);
  ui.setStress('running');
}

/** Run as many stress-test flights as fit in this frame's time budget (at least one). */
function advanceStress(): void {
  if (!stressGen) return;
  const start = performance.now();
  for (;;) {
    const step = stressGen.next();
    if (step.done) {
      stressGen = null;
      lastStress = step.value;
      ui.setStress(step.value);
      ui.toast('Stress test complete');
      return;
    }
    if (performance.now() - start > STRESS_FRAME_BUDGET_MS) return;
  }
}

// ---------- Per-frame world update ----------

function maxWarpFor(s: Sim | null): number {
  if (!s || s.done) return Infinity;
  return s.state.altitude < WARP_CAP_ALTITUDE || s.state.thrust > 0 ? WARP_CAP_ATMOSPHERE : Infinity;
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
  if (live && state && rocket && toggles.trail && simDt > 0) {
    trailAcc += simDt;
    if (trailAcc >= TRAIL_INTERVAL_S) {
      trailAcc = 0;
      trail.push(state.pos);
    }
    if (state.thrust > 0 && state.altitude < SMOKE_ALT_LIMIT) {
      emitAcc += simDt * SMOKE_PUFFS_PER_SIM_S;
      while (emitAcc >= 1) {
        emitAcc -= 1;
        smoke.emit(nozzlePhysical(state, rocket), rocket.maxRadius * 3);
      }
    }
  }
  smoke.update(realDt, origin);
  trail.update(origin);
}

function updateParachute(state: SimState | null): void {
  if (!rocket || !rocketRoot || !state) {
    if (chute) chute.visible = false;
    return;
  }
  if (state.chuteDeployed && !chute) {
    const p = firstParachute(rocket);
    if (p) {
      chute = buildParachute(p.diameter);
      scene.add(chute);
    }
  }
  if (!chute) return;
  chute.visible = state.chuteDeployed;
  chute.position.copy(rocketRoot.position);
  // Canopy points opposite the velocity; when nearly still, straight up.
  const speed = len(state.vel);
  const dir =
    speed > 1
      ? new THREE.Vector3(...state.vel).multiplyScalar(-1 / speed)
      : new THREE.Vector3(...state.pos).normalize();
  chute.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
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

function updateSky(state: SimState | null, origin: Vec3): void {
  // Sky and stars follow the CAMERA altitude, so the map view sees space.
  const camAlt = Math.hypot(origin[0] + camera.position.x, origin[1] + camera.position.y, origin[2] + camera.position.z) - R_EARTH;
  const altitude = Math.max(state ? state.altitude : 0, camAlt);
  const up = state ? new THREE.Vector3(...state.pos).normalize() : new THREE.Vector3(0, 1, 0);
  sky.update(altitude, solar.sunDirection, up);
  // Stars only show once the sky has thinned out with altitude.
  const stars = solar.group.getObjectByName('Stars') as THREE.Points | undefined;
  if (stars) {
    const mat = stars.material as THREE.PointsMaterial;
    mat.transparent = true;
    mat.opacity = Math.min(1, Math.max(0, (altitude - 15_000) / 55_000));
    stars.visible = mat.opacity > 0.01;
  }
}

function updateWorld(state: SimState | null, origin: Vec3, realDt: number, simDt: number, now: number): void {
  solar.update(clock.jd, origin, camera.position);
  site.update(origin, activeConfig.launchAltitude);
  site.group.position.y -= padLift;

  placeRocket(state, origin, now);
  updateSmokeAndTrail(state, origin, simDt, realDt);
  updateParachute(state);
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
  if (state) ui.setTelemetry(state, clock.warp, clock.paused);
}

function frame(now: number): void {
  const realDt = Math.max(0, (now - lastNow) / 1000);
  lastNow = now;

  if (appMode === 'builder') {
    builderView.render(renderer);
    requestAnimationFrame(frame);
    return;
  }

  const simDt = clock.tick(realDt);
  clock.setMaxWarp(maxWarpFor(sim));
  advanceSim(simDt);
  advanceStress();

  const state = displayState();
  const origin = originFor(cameraRig.mode, state);
  updateWorld(state, origin, realDt, simDt, now);
  updateCamera(realDt, origin);
  updateHud(state);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------- UI wiring ----------

const ui: UI = createUI(app, {
  onFile: (file) => {
    void loadFile(file);
  },
  onLoadSample: loadSample,
  onLaunch: launch,
  onReset: resetSim,
  onWarp: (delta) => {
    if (delta > 0) clock.warpUp();
    else clock.warpDown();
  },
  onPause: () => {
    clock.paused = !clock.paused;
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
});

// ---------- Build mode glue ----------

let appMode: 'flight' | 'builder' = 'flight';
let builderHistory: History<Design> | null = null;
let builderSelectedId: string | null = null;
let builderCutaway = false;
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
  const twr = m && mp.mass > 0 ? peakThrust(m) / (mp.mass * G0) : null;
  const preFlaws = preflightFlaws(model, m, mp.mass, stabilityCal).map((s) => s.flaw);
  const flightIds = new Set(lastFlightFlaws.map((f) => f.id));
  const mergedFlaws = [
    ...lastFlightFlaws,
    ...preFlaws.filter((f) => !flightIds.has(f.id)),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    stats: {
      length: model.length,
      mass: mp.mass,
      stabilityCal,
      twr,
      motorLabel: m ? motorKey(m) : null,
      flaws: mergedFlaws,
    },
    cgX: mp.cgX,
    cpX: ap.cpX,
  };
}

function refreshBuilder(refitCamera = false, forceInspectorRefresh = false): void {
  const d = currentDesign();
  if (!d || !builderHistory) return;
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
    savedDesigns: listSavedDesigns(),
    completedChallenges: loadCompletedChallenges(),
    forceInspectorRefresh,
  });
}

function clearPlacement(): void {
  placingPreset = null;
  placingSnaps = [];
  hoveredSnapId = null;
  builderView.setSnapPoints([]);
  builderUi.setPlacing(null, []);
}

function commitSnapPlacement(preset: PartPreset, snap: SnapPoint, addTransition?: boolean): void {
  const base = currentDesign() ?? createEmptyDesign();
  // If diameter mismatches and caller hasn't decided yet, ask whether to insert a transition.
  if (addTransition === undefined && !snap.diameterMatch && snap.needsTransition) {
    builderUi.setTransitionPrompt({ preset, snap });
    return;
  }
  const part = preset.create();
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
    if (placingPreset) clearPlacement();
  },
  onSelectPart: (partId) => {
    builderSelectedId = partId;
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
    refreshBuilder(false, false);
  },
  onFrameCamera: () => builderView.frameRocket(),
  onGoToPad: () => exitBuilderToPad(),
  onSaveDesign: () => {
    const d = currentDesign();
    if (!d) return;
    const thumb = builderView.captureThumbnail(renderer);
    saveDesign(d, thumb);
    ui.toast(`Saved "${d.name}"`);
    refreshBuilder(false, false);
  },
  onLoadSavedDesign: (design) => {
    builderHistory = createHistory(design);
    builderSelectedId = null;
    lastFlightFlaws = [];
    clearPlacement();
    refreshBuilder(true, true);
    ui.toast(`Loaded "${design.name}"`);
  },
  onDeleteSavedDesign: (id) => {
    deleteSavedDesign(id);
    refreshBuilder(false, false);
  },
  onExportJson: () => {
    const d = currentDesign();
    if (!d) return;
    const blob = new Blob([exportDesignJson(d)], { type: 'application/json' });
    downloadBlob(blob, `${safeFilename(d.name)}.json`);
  },
  onExportOrk: () => {
    const d = currentDesign();
    if (!d) return;
    void exportOrkZip(d).then((bytes) => {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const blob = new Blob([ab], { type: 'application/zip' });
      downloadBlob(blob, `${safeFilename(d.name)}.ork`);
    });
  },
  onImportFile: (file) => {
    void importBuilderFile(file);
  },
});

function safeFilename(name: string): string {
  return (name || 'rocket').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'rocket';
}

function downloadBlob(blob: Blob, filename: string): void {
  saveBlob(blob, filename).then(
    (how) => { if (how === 'saved') ui.toast(`Saved ${filename}`); },
    (err: unknown) => ui.toast(`Could not save ${filename}: ${err instanceof Error ? err.message : String(err)}`),
  );
}

async function importBuilderFile(file: File): Promise<void> {
  try {
    if (/\.json$/i.test(file.name)) {
      const imported = importDesignJson(await file.text());
      builderHistory = createHistory(imported);
      builderSelectedId = null;
      lastFlightFlaws = [];
      clearPlacement();
      refreshBuilder(true, true);
      ui.toast(`Imported "${imported.name}"`);
      return;
    }
    const { xml, files } = await readOrkZip(await file.arrayBuffer());
    const model = parseOrkXml(xml);
    adoptEmbeddedMotors(embeddedMotors(files));
    builderHistory = createHistory(fromRocketModel(model));
    builderSelectedId = null;
    lastFlightFlaws = [];
    clearPlacement();
    refreshBuilder(true, true);
    ui.toast(`Opened "${model.name}" in builder`);
  } catch (e) {
    ui.toast(`Import failed: ${errorMessage(e)}`);
  }
}

function enterBuilder(): void {
  if (!builderHistory) {
    const initial = rocket ? fromRocketModel(rocket) : createEmptyDesign();
    builderHistory = createHistory(initial);
  }
  appMode = 'builder';
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
  appMode = 'flight';
  clearPlacement();
  builderView.setEnabled(false);
  cameraRig.setEnabled(true);
  builderUi.setVisible(false);
  ui.setVisible(true);
  ui.setBuildLabel?.('Back to Builder');
  loadRocket(model);
}

// Click on the 3D canvas in builder mode places on a snap point (if placing) or selects a part.
let builderDownPos: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (appMode !== 'builder') return;
  builderDownPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (appMode !== 'builder' || !placingPreset || placingSnaps.length === 0) return;
  const hit = builderView.pickSnapPoint(e.clientX, e.clientY);
  const nextId = hit?.id ?? null;
  if (nextId !== hoveredSnapId) {
    hoveredSnapId = nextId;
    builderView.setSnapPoints(placingSnaps, hoveredSnapId);
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (appMode !== 'builder' || !builderDownPos) return;
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
    refreshBuilder(false);
  }
});

// Desktop drag-from-palette onto 3D canvas snap points.
renderer.domElement.addEventListener('dragover', (e) => {
  if (appMode !== 'builder' || !placingPreset) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  const hit = builderView.pickSnapPoint(e.clientX, e.clientY);
  const nextId = hit?.id ?? null;
  if (nextId !== hoveredSnapId) {
    hoveredSnapId = nextId;
    builderView.setSnapPoints(placingSnaps, hoveredSnapId);
  }
});
renderer.domElement.addEventListener('drop', (e) => {
  if (appMode !== 'builder' || !placingPreset) return;
  e.preventDefault();
  const snap = builderView.pickSnapPoint(e.clientX, e.clientY) ?? placingSnaps[0] ?? null;
  const preset = placingPreset;
  if (snap && preset) {
    commitSnapPlacement(preset, snap);
  } else {
    clearPlacement();
  }
});

activeConfig = ui.getConfig();

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  builderView.resize(w, h);
  renderer.setSize(w, h);
});

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

loadSample();
requestAnimationFrame(frame);

// Title screen, once per browser session (returning from the Moon page skips it).
mountHero(app, {
  onBuild: () => enterBuilder(),
  onFly: () => {},
  onMoon: () => window.location.assign('./landing.html'),
});

// Debug hook to fly a mission from the browser console.
interface MissionDebugHook {
  astraRunMission?: (id?: string) => Promise<unknown>;
}
(window as Window & MissionDebugHook).astraRunMission = (id = 'lvm3-m4') =>
  import('../mission/client').then((m) => m.runMission(id));
