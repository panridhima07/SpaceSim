# Physics 01 — pressure and thermal faults

Paste everything below the line into ChatGPT Luna small, started in `C:\Users\medha\Desktop\Hackathons\Astra` on branch `app`.

The thresholds and "expected" numbers in this prompt were measured on 22 Nov 2026 by flying the nominal LVM3-M4 mission with a prototype of these formulas. If your numbers differ by more than the stated tolerance, your formula is wrong; do not change the threshold.

---

You are continuing work on Astra, a hackathon project: a TypeScript + Three.js + Vite web app, packaged for Android with Capacitor, that designs and flies rockets in 3D. Your job in this session is to add **pressure-related and temperature-related fault detection** to both physics engines. You are adding new files and a few small hooks. You are not changing how any rocket flies.

## Where the project stands

- Branch `app`. `npm run typecheck` is clean, `npm test` passes 349 tests in 43 files, and `npm test` inside `rocket-physics\` passes 200 tests.
- There are two physics engines, and they stay separate:
  - `rocket-physics\` — orbital launch library (6-DOF ascent, staging, guidance, LVM3 preset). Plain Node, no dependencies, tests use `node:test`. Z-up inertial frame, body +X is the nose.
  - `src\physics\` — model-rocket simulator (Barrowman aerodynamics, validated against OpenRocket). Tests use Vitest. `src\physics\flaws.ts` holds the existing design-review rules (stability, rail speed, fin flutter, and so on).
- `src\mission\` connects the library to the app: `fly.ts` flies a mission and returns a `FlightRecord` (`record.ts`), `adapter.ts` converts frames and events, `vehicles.ts` lists missions (only `lvm3-m4` today).
- The app has no mission-mode screen yet. Do not build one. Your output is data on the `FlightRecord` and tests.
- The working tree has **uncommitted work by other people** in `src\app\`, `src\builder\`, `src\render\`, `src\types.ts`, `landing.html` and others. It is not yours.

## Rules

- Do the steps in order. After each step run its check. If the check passes, commit and go on.
- If a check fails, try to fix it at most twice. If it still fails, stop, write what happened in `docs\PHYSICS-PROGRESS.md` (the command, the last 30 lines of output, what you tried), commit that file, and end the session. Never delete, skip or loosen a test, and never change a threshold or an expected number in this prompt, to make a check pass.
- The shell is PowerShell on Windows. Node is v26. Run commands from the repo root unless a step says otherwise.
- Read a file before you change it. Change only the files a step names.
- Commits: local only. Never `git push`. Stage files by name: `git add <the paths this step names>`. Never run `git add -A`, `git add .`, `git commit -a`, `git stash`, `git restore`, `git checkout -- <file>` or `git reset`: they would sweep up or destroy the other people's uncommitted work. Plain one-line commit messages. No mention of any AI tool or assistant, and no `Co-Authored-By` line, in any commit message or file.
- Inside `rocket-physics\`: only erasable TypeScript (no `enum`, no `namespace`, no constructor parameter properties), imports keep the `.ts` extension, type-only imports use `import type`. No dependencies.
- Do not edit `rocket-physics\src\sim\simulation.ts`, `rocket-physics\src\gnc\`, `src\physics\sim.ts`, `src\physics\aero.ts`, `src\physics\massprops.ts`, or anything under `src\app\`, `src\builder\`, `src\render\`. If you think you need to, stop and write why in the progress file.
- All units SI: Pa, K, m, kg, s, N, W/m^2. Angles in rad.
- After every step append to `docs\PHYSICS-PROGRESS.md`: step name, `Status: done` or `failed`, commit hash, what changed, test counts, and every measured number the step asks you to record.

Baseline, before Step 1:

```powershell
npm run typecheck
npm test
cd rocket-physics; npm test; cd ..
```

Expected: typecheck clean, 349 passed, 200 passed. If the baseline is not green, stop and record it. (`src\validate\series.test.ts` can time out when the machine is busy; rerun once before calling it a failure.)

---

# Part A — orbital engine (`rocket-physics\src\faults\`)

Design: a passive **fault monitor**. It reads `sim.diag` after every simulation step, keeps a few small state variables of its own (fairing internal pressure, nose skin temperature, boiled-off propellant), and records faults. It never changes the simulation. Vehicle data the monitor needs (wall thickness, tank pressure, chamber pressure) lives in a separate `FaultSpec`, so `VehicleSpec` and every existing file stay untouched.

Read these before you start: `rocket-physics\src\sim\simulation.ts` (the `Diagnostics` interface, `Simulation` fields, `substep`), `rocket-physics\src\vehicle\types.ts`, `rocket-physics\src\vehicle\presets.ts`, `rocket-physics\src\propulsion\nozzle.ts`, `rocket-physics\src\aero\aero.ts` (last 20 lines), `rocket-physics\test\sim.test.ts` (first 60 lines, for the test style).

## Step A1 — fluids and materials

Create `rocket-physics\src\faults\fluids.ts`:

```ts
export interface Fluid {
  name: string;
  density: number;        // liquid, kg/m^3
  boilingPoint: number;   // at 101325 Pa, K
  latentHeat: number;     // J/kg
  molarMass: number;      // kg/mol
  storageTemp: number;    // temperature it is loaded at, K
}
export const FLUIDS = {
  LOX:  { name: 'LOX',  density: 1141,  boilingPoint: 90.19, latentHeat: 213e3, molarMass: 0.031999, storageTemp: 90.19 },
  LH2:  { name: 'LH2',  density: 70.85, boilingPoint: 20.28, latentHeat: 446e3, molarMass: 0.002016, storageTemp: 20.28 },
  RP1:  { name: 'RP-1', density: 810,   boilingPoint: 490,   latentHeat: 250e3, molarMass: 0.170,    storageTemp: 300 },
  UH25: { name: 'UH25', density: 850,   boilingPoint: 336,   latentHeat: 583e3, molarMass: 0.0601,   storageTemp: 303 },
  N2O4: { name: 'N2O4', density: 1440,  boilingPoint: 294.3, latentHeat: 414e3, molarMass: 0.09201,  storageTemp: 303 },
} as const satisfies Record<string, Fluid>;
export type FluidId = keyof typeof FLUIDS;
```

- `vapourPressure(f: Fluid, T: number): number` — Clausius–Clapeyron from the boiling point:
  `P0 * exp((f.latentHeat * f.molarMass / R_GAS) * (1 / f.boilingPoint - 1 / T))`. Import `P0` and `R_GAS` from `../constants.ts`.
- `isCryogenic(f: Fluid): boolean` — `f.boilingPoint < 200`.

Create `rocket-physics\src\faults\materials.ts`:

```ts
export interface Material {
  name: string;
  youngsModulus: number;  // Pa
  ultimate: number;       // tensile ultimate, Pa
  density: number;        // kg/m^3
  specificHeat: number;   // J/(kg K)
  warnTemp: number;       // K, strength starts to fall
  maxTemp: number;        // K, do not exceed
}
export const MATERIALS = {
  AL2219: { name: 'Aluminium 2219', youngsModulus: 73.1e9, ultimate: 440e6,  density: 2840, specificHeat: 864, warnTemp: 423, maxTemp: 450 },
  M250:   { name: 'M250 maraging steel', youngsModulus: 186e9, ultimate: 1760e6, density: 8000, specificHeat: 460, warnTemp: 600, maxTemp: 700 },
} as const satisfies Record<string, Material>;
export type MaterialId = keyof typeof MATERIALS;
```

Create `rocket-physics\test\faults.test.ts` (same imports and `relClose` helper style as `test\sim.test.ts`, but import from the `../src/faults/*.ts` files directly for now). Tests:

| call | expected | tolerance |
|---|---|---|
| `vapourPressure(FLUIDS.LOX, 90.19)` | 101325 | 1e-9 relative |
| `vapourPressure(FLUIDS.N2O4, 303)` | 158430 | 1 % |
| `vapourPressure(FLUIDS.UH25, 303)` | 25851 | 1 % |
| `vapourPressure(FLUIDS.LH2, 22)` | 153700 | 1 % |
| `vapourPressure(FLUIDS.RP1, 300)` | below 500 | — |
| `isCryogenic` | true for LOX and LH2, false for the other three | — |

Check: `cd rocket-physics; npm test; cd ..` — all pass (200 + your new ones).
Commit: `git add rocket-physics/src/faults rocket-physics/test/faults.test.ts`.

## Step A2 — pressure functions

Create `rocket-physics\src\faults\pressure.ts`. Every function is pure.

1. `hoopStress(dp: number, r: number, t: number): number` → `dp * r / t`. Thin-wall cylinder, `dp` = inside minus outside.
2. `axialPressureStress(dp, r, t)` → `dp * r / (2 * t)`. Internal pressure also stretches the wall lengthwise; this tension is what lets a thin tank carry thrust without buckling.
3. `knockdown(r, t)` → `1 - 0.901 * (1 - Math.exp(-Math.sqrt(r / t) / 16))`. NASA SP-8007 empirical factor: real thin shells buckle well below the textbook load.
4. `shellBucklingStress(E, t, r)` → `knockdown(r, t) * 0.605 * E * t / r`.
5. `equivalentAxialLoad(force, moment, r)` → `force + 2 * moment / r`. Turns a bending moment into the axial force that loads the worst side of the shell equally.
6. `nozzleExitPressure(pc, expansionRatio, gamma)` → `Me = machFromAreaRatio(expansionRatio, gamma)` (import from `../propulsion/nozzle.ts`), then `pc * Math.pow(1 + ((gamma - 1) / 2) * Me * Me, -gamma / (gamma - 1))`.
7. `separationState(pe, pa): 'attached' | 'marginal' | 'separated'` → `'separated'` if `pe < 0.25 * pa`, `'marginal'` if `pe < 0.4 * pa` (Summerfield criterion), else `'attached'`.
8. `solidPressureFactor(grainTemp, refTemp = 300, piK = 0.00277)` → `Math.exp(piK * (grainTemp - refTemp))`. A warm solid grain burns faster, so chamber pressure rises about 0.28 % per kelvin.
9. `ventStep(pInt, pExt, dt, volume, ventArea, cd = 0.6, gasTemp = 288): number` — pressure inside a vented compartment (the fairing) after `dt`. Air leaves through an orifice; the inside pressure lags the outside. Algorithm, exactly:

```ts
if (ventArea <= 0 || volume <= 0 || dt <= 0) return pInt;
const n = Math.min(2000, Math.max(1, Math.ceil(dt / 0.005)));
const h = dt / n;
let p = pInt;
for (let i = 0; i < n; i++) {
  const dp = p - pExt;
  const rho = p / (287.05 * gasTemp);
  if (Math.abs(dp) < 1e-9 || rho <= 0) continue;
  const mdot = cd * ventArea * Math.sqrt(2 * Math.abs(dp) * rho) * Math.sign(dp);
  let change = -((1.4 * p) / (rho * volume)) * mdot * h;
  if (Math.abs(change) > Math.abs(dp)) change = -dp;   // never overshoot the outside pressure
  p += change;
}
return p;
```

Add tests to `rocket-physics\test\faults.test.ts`:

| call | expected | tolerance |
|---|---|---|
| `hoopStress(0.35e6, 2, 0.004)` | 175e6 | 1e-9 rel |
| `axialPressureStress(0.35e6, 2, 0.004)` | 87.5e6 | 1e-9 rel |
| `knockdown(2, 0.004)` | 0.32173 | 0.1 % |
| `shellBucklingStress(73.1e9, 0.004, 2)` | 28.46e6 | 0.5 % |
| `equivalentAxialLoad(1e6, 7.4e5, 2)` | 1.74e6 | 1e-9 rel |
| `nozzleExitPressure(5.85e6, 13.88, 1.2)` (Vikas) | 47666 | 1 % |
| `nozzleExitPressure(6.0e6, 100, 1.2)` (CE-20) | 3945 | 1 % |
| `nozzleExitPressure(5.69e6, 12.1, 1.18)` (S200) | 58818 | 1 % |
| `separationState(47666, 101325)` | `'attached'` | — |
| `separationState(3945, 101325)` | `'separated'` (a vacuum engine lit at sea level) | — |
| `separationState(37400, 101325)` | `'marginal'` | — |
| `solidPressureFactor(318)` | 1.05112 | 0.01 % |
| `solidPressureFactor(300)` | 1 | exact |
| `ventStep(101325, 50000, 10, 110, 0)` | 101325 (sealed) | exact |
| `ventStep(101325, 50000, 1000, 110, 0.08)` | 50000 | within 1 Pa |
| `ventStep(101325, 50000, 0.1, 110, 0.08)` | strictly between 50000 and 101325 | — |
| `ventStep(50000, 101325, 0.1, 110, 0.08)` | strictly between 50000 and 101325 (air flows in) | — |

Check: `cd rocket-physics; npm test; cd ..`. Commit `rocket-physics/src/faults/pressure.ts` and the test file.

## Step A3 — thermal functions

Create `rocket-physics\src\faults\thermal.ts`:

1. `export const STEFAN_BOLTZMANN = 5.670374419e-8;`
2. `recoveryTemperature(Tinf, mach, r = 0.89)` → `Tinf * (1 + r * 0.2 * mach * mach)`. The temperature the air next to the skin reaches; the skin can never get hotter than this by convection.
3. `radiativeEquilibriumTemp(heatFlux, emissivity)` → `Math.pow(heatFlux / (emissivity * STEFAN_BOLTZMANN), 0.25)`; return 0 if `heatFlux <= 0`.
4. `arealHeatCapacity(density, specificHeat, thickness)` → the product, J/(m^2 K).
5. `skinStep(Tw, coldWallFlux, Taw, dt, capacity, emissivity, sinkTemp = 250): number` — skin temperature after `dt`. Heating falls off as the wall approaches the recovery temperature; the wall radiates to a 250 K background. No convective cooling (conservative). Algorithm, exactly:

```ts
const n = Math.max(1, Math.ceil(dt / 1));      // sub-steps of at most 1 s
const h = dt / n;
let T = Tw;
for (let i = 0; i < n; i++) {
  const f = Math.min(1, Math.max(0, (Taw - T) / Math.max(Taw - 300, 1)));
  const net = coldWallFlux * f - emissivity * STEFAN_BOLTZMANN * (T ** 4 - sinkTemp ** 4);
  T += (h * net) / capacity;
}
return T;
```

6. `heatLeak(u, area, outsideTemp, liquidTemp)` → `Math.max(0, u * area * (outsideTemp - liquidTemp))`, W.
7. `boilOffRate(leak, latentHeat)` → `leak / latentHeat`, kg/s.
8. `tankSurfaceArea(r, length)` → `2 * Math.PI * r * length + 2 * Math.PI * r * r`.

Tests:

| call | expected | tolerance |
|---|---|---|
| `recoveryTemperature(288.15, 2)` | 493.31 | 0.01 % |
| `recoveryTemperature(288.15, 0)` | 288.15 | exact |
| `radiativeEquilibriumTemp(28448, 0.8)` | 889.9 | 0.1 % |
| `radiativeEquilibriumTemp(0, 0.8)` | 0 | exact |
| `arealHeatCapacity(2840, 864, 0.006)` | 14722.56 | 1e-9 rel |
| `skinStep(300, 20000, 1000, 1, 14722.56, 0.8)` | 301.3455 | 0.001 K |
| `skinStep(300, 0, 300, 100, 14722.56, 0.8)` | less than 300 (it only radiates) | — |
| `skinStep(900, 20000, 600, 1, 14722.56, 0.8)` | less than 900 (wall hotter than recovery: no heating) | — |
| `tankSurfaceArea(2, 8)` | 125.66 | 0.01 % |
| `heatLeak(0.8, 125.66, 303, 20.28)` | 28421 | 0.1 % |
| `boilOffRate(28421, 446e3)` | 0.06372 | 0.1 % |

Check and commit as before.

## Step A4 — the fault spec and the LVM3 data

Create `rocket-physics\src\faults\spec.ts`:

```ts
import type { FluidId } from './fluids.ts';
import type { MaterialId } from './materials.ts';

export interface TankFaultSpec {
  fluid: FluidId | null;        // null for a solid grain
  wallThickness: number;        // m
  material: MaterialId;
  ullagePressure: number;       // regulated gas pressure above the liquid, Pa absolute
  npshRequired: number;         // pressure the pump inlet needs above vapour pressure, Pa
  insulationU: number;          // heat transfer coefficient through the wall, W/(m^2 K); 0 = ignore
}
export interface SolidFaultSpec {
  meop: number;                 // maximum expected operating pressure, Pa
  grainTemp: number;            // K
  refTemp: number;              // K, temperature the nominal curve was measured at
  piK: number;                  // per K
  caseThickness: number;        // m
  caseRadius: number;           // m
  caseMaterial: MaterialId;
}
export interface StageFaultSpec {
  tanks: TankFaultSpec[];       // same order and count as VehicleSpec.stages[i].tanks
  chamberPressure: number;      // at full throttle (solid: at thrust-curve value 1), Pa
  expansionRatio: number;
  gamma: number;
  solid?: SolidFaultSpec;
  maxSeparationQ: number;       // Pa
}
export interface FaultSpec {
  stages: StageFaultSpec[];     // same order and count as VehicleSpec.stages
  fairing?: { volume: number; ventArea: number; maxDeltaP: number; maxDepressRate: number };
  noseSkin: { material: MaterialId; thickness: number; emissivity: number };
  limits: { maxQ: number; maxQAlpha: number; maxG: number; payloadHeatFlux: number };
  ambientTemp: number;          // K
  padHoldSeconds: number;       // time tanked on the pad before liftoff with no topping-up
}
```

Add `lvm3FaultSpec(): FaultSpec` in the same file. Put this comment above it: `// Representative engineering estimates sized to give realistic margins. Not ISRO data.` Stage order matches `lvm3()` in `presets.ts`: index 0 = L110 core, 1 = S200 boosters, 2 = C25.

| stage | field | value |
|---|---|---|
| 0 L110 | tanks[0] (UH25) | fluid `'UH25'`, wallThickness 0.004, `'AL2219'`, ullagePressure 0.35e6, npshRequired 0.10e6, insulationU 0 |
| 0 L110 | tanks[1] (N2O4) | fluid `'N2O4'`, same other values |
| 0 L110 | engine | chamberPressure 5.85e6, expansionRatio 13.88, gamma 1.2, maxSeparationQ 1000 |
| 1 S200 | tanks[0] | fluid `null`, wallThickness 0.0078, `'M250'`, ullagePressure 0, npshRequired 0, insulationU 0 |
| 1 S200 | engine | chamberPressure 5.69e6, expansionRatio 12.1, gamma 1.18, maxSeparationQ 1000 |
| 1 S200 | solid | meop 5.88e6, grainTemp 300, refTemp 300, piK 0.00277, caseThickness 0.0078, caseRadius 1.5, `'M250'` |
| 2 C25 | tanks[0] (LOX) | fluid `'LOX'`, wallThickness 0.003, `'AL2219'`, ullagePressure 0.25e6, npshRequired 0.05e6, insulationU 0.8 |
| 2 C25 | tanks[1] (LH2) | fluid `'LH2'`, wallThickness 0.003, `'AL2219'`, ullagePressure 0.20e6, npshRequired 0.05e6, insulationU 0.8 |
| 2 C25 | engine | chamberPressure 6.0e6, expansionRatio 100, gamma 1.2, maxSeparationQ 1000 |
| — | fairing | volume 110, ventArea 0.08, maxDeltaP 7000, maxDepressRate 3500 |
| — | noseSkin | `'AL2219'`, thickness 0.006, emissivity 0.8 |
| — | limits | maxQ 55000, maxQAlpha 3000, maxG 4.0, payloadHeatFlux 1135 |
| — | ambientTemp | 303 |
| — | padHoldSeconds | 0 |

Add scenarios in the same file. Each returns a deep copy (`structuredClone`) with one thing wrong:

```ts
export const SCENARIOS = ['blocked-vent', 'regulator-low', 'regulator-high', 'hot-grain', 'thin-nose', 'long-hold'] as const;
export type ScenarioId = (typeof SCENARIOS)[number];
export function applyScenario(spec: FaultSpec, id: ScenarioId): FaultSpec
```

| id | change |
|---|---|
| `blocked-vent` | `fairing.ventArea *= 0.25` |
| `regulator-low` | every tank with a non-null fluid: `ullagePressure *= 0.5` |
| `regulator-high` | every tank with a non-null fluid: `ullagePressure *= 2.2` |
| `hot-grain` | every stage with `solid`: `solid.grainTemp = 318` |
| `thin-nose` | `noseSkin.thickness = 0.003` |
| `long-hold` | `padHoldSeconds = 3600` |

Tests: `lvm3FaultSpec().stages.length === lvm3().stages.length`; for every stage `tanks.length` matches the vehicle; `applyScenario` does not mutate its input; each scenario changes the field in the table.

Check and commit.

## Step A5 — the monitor

Create `rocket-physics\src\faults\monitor.ts`.

```ts
export type FaultSeverity = 'info' | 'warning' | 'critical';
export type FaultSystem = 'pressure' | 'thermal' | 'structure' | 'propulsion';
export interface Fault {
  id: string;            // e.g. 'tank-burst:0:1'
  system: FaultSystem;
  severity: FaultSeverity;
  stage?: number;
  t: number;             // seconds after liftoff when the worst value occurred (negative on the pad)
  value: number;
  limit: number;
  unit: string;
  title: string;
  detail: string;        // one or two plain sentences that include the numbers
  fix: string;           // what an engineer would change
}
export interface FaultChannels {      // latest values, for telemetry displays
  skinTemp: number;                   // K
  fairingDeltaP: number;              // Pa, inside minus outside; 0 once the fairing is gone
  fairingPressure: number;            // Pa
  depressRate: number;                // Pa/s, positive while pressure is falling
}
export class FaultMonitor {
  channels: FaultChannels;
  constructor(vehicle: VehicleSpec, spec: FaultSpec);
  observe(sim: Simulation): void;     // call once after every simulation step
  report(): Fault[];                  // critical first, then warning, then info; ties by t
}
export function monitored(inner: FlightComputer, monitor: FaultMonitor): FlightComputer;
```

`monitored` returns `{ update(sim) { monitor.observe(sim); return inner.update(sim); } }`. `Simulation.substep` calls the flight computer once per step with `sim.diag` fresh, so this observes every step.

**Recording rule.** Keep a `Map<string, Fault>`. A private `raise(fault)` stores the fault if the id is new, or replaces the stored one if the new one is more severe, or equally severe with a worse value. "Worse" is passed by the caller as a boolean. This way each id appears once in the report with its worst moment.

**Setup in the constructor.** Store `tankOffsets(vehicle)`. `skinTemp = spec.ambientTemp`. `fairingPressure = NaN` (set on the first `observe` to `sim.diag.pressure`). `lastT = NaN`. Skin capacity = `arealHeatCapacity(material.density, material.specificHeat, noseSkin.thickness)`. For each cryogenic tank with `insulationU > 0` start a boiled-off total at `boilOffRate(heatLeak(U, tankSurfaceArea(r, tank.length), spec.ambientTemp, fluid.storageTemp), fluid.latentHeat) * spec.padHoldSeconds`, where `r = tank.radius ?? stage.radius`. Also remember each stage's `attached` flag and `fairingAttached` from `sim.rt` so you can detect the step where they change.

**Static check, done once on the first `observe`:** for every stage `i` with `spec.stages[i].solid`:
- `pcMax = chamberPressure * solidPressureFactor(grainTemp, refTemp, piK)`.
- id `chamber-overpressure:i`, system `propulsion`: critical if `pcMax > meop`; warning if `pcMax > 0.98 * meop`. value `pcMax`, limit `meop`, unit `Pa`, `t = 0`. Fix text: condition the motor to its qualified temperature range before launch.

**Every `observe(sim)`**, with `d = sim.diag`:

```
lifted = Number.isFinite(sim.liftoffTime)
mt     = lifted ? sim.t - sim.liftoffTime : 0     // this is the `t` you store on a fault
dt     = Number.isFinite(lastT) ? sim.t - lastT : 0;  lastT = sim.t
a      = lifted ? d.accelG * G0 : G0          // sensed axial acceleration, m/s^2
moment = Math.hypot(d.aeroMoment[1], d.aeroMoment[2])
```

Run every check below even when `dt === 0`, except the three integrators (vent, skin, boil-off), which need `dt > 0`.

1. **`max-q`** (structure). Only when `lifted`. critical if `d.q > limits.maxQ`; warning if `d.q > 0.9 * limits.maxQ`. unit `Pa`.
2. **`q-alpha`** (structure). Only when `lifted` and `d.q > 1000`. `v = d.q * Math.abs(d.alpha)`. critical if `v > limits.maxQAlpha`; warning if `v > 0.7 * limits.maxQAlpha`. unit `Pa rad`. This is the bending load: dynamic pressure times angle of attack.
3. **`axial-g`** (structure). critical if `d.accelG > 1.25 * limits.maxG`; warning if `d.accelG > limits.maxG`. unit `g`.
4. **Per tank**, for every stage `i` that is attached (`sim.rt.stages[i].attached`), every tank `k`, with `ts = spec.stages[i].tanks[k]`, `tk = vehicle.stages[i].tanks[k]`, `r = tk.radius ?? stage.radius`, `m = sim.prop[offs[i] + k]`, `mat = MATERIALS[ts.material]`:
   - Skip the tank if `ts.fluid === null`.
   - `fluid = FLUIDS[ts.fluid]`; `hLiq = Math.min(tk.length, m / (fluid.density * Math.PI * r * r))`; `head = fluid.density * a * hLiq`; `pBottom = ts.ullagePressure + head`.
   - **`tank-burst:i:k`** (pressure). `dp = pBottom - d.pressure`. Skip if `dp <= 0`. `fos = mat.ultimate / hoopStress(dp, r, ts.wallThickness)`. critical if `fos < 1.1`; warning if `fos < 1.4`. value `fos`, limit `1.4`, unit `factor of safety`. Worse = lower.
   - **`tank-buckling:i:k`** (structure). Only for core stages (`!vehicle.stages[i].parallel`).
     `mAbove` = payload mass + fairing mass if `sim.rt.fairingAttached` + for every core stage `j > i` that is attached: its `dryMass` plus its current propellant + the current propellant of every tank in stage `i` whose `bottom` is greater than `tk.bottom`.
     `load = equivalentAxialLoad(mAbove * a + Math.max(0, d.drag), moment, r)`.
     `compress = load / (2 * Math.PI * r * ts.wallThickness)`.
     `relief = axialPressureStress(ts.ullagePressure - d.pressure, r, ts.wallThickness)`.
     `util = (compress - relief) / shellBucklingStress(mat.youngsModulus, ts.wallThickness, r)`.
     critical if `util > 1.0`; warning if `util > 0.6`. value `util`, limit `1`, unit `utilisation`. A negative `util` means the wall is in tension: no fault. Fix text: raise tank pressure or thicken the wall; this tank only stands up because it is pressurised.
   - **`cavitation:i:k`** (propulsion). Only while `sim.rt.stages[i].engineOn && sim.rt.stages[i].throttle > 0`. `margin = ts.ullagePressure + head - vapourPressure(fluid, fluid.storageTemp) - ts.npshRequired`. critical if `margin < 0`; warning if `margin < 0.25 * ts.npshRequired`. value `margin`, limit `0`, unit `Pa`. Worse = lower. Fix text: the pump inlet pressure is at or below the propellant's vapour pressure, so the pump would cavitate; raise ullage pressure or chill the propellant.
   - **Boil-off** (thermal). If `isCryogenic(fluid) && ts.insulationU > 0 && dt > 0`: add `boilOffRate(heatLeak(...same arguments as in setup...), fluid.latentHeat) * dt` to this tank's total. Then `frac = total / tk.propellantMass`; id **`boil-off:i:k`**: warning if `frac > 0.03`; info if `frac > 0.01`. value `frac * 100`, limit `3`, unit `%`.
5. **Per burning stage**, for every stage `i` with `attached && engineOn`, with `ss = spec.stages[i]`, `e = vehicle.stages[i].engine`, `st = sim.rt.stages[i]`:
   - `thr = e.thrustCurve ? thrustCurveAt(e.thrustCurve, sim.t - st.ignitionTime) : st.throttle`.
   - `factor = ss.solid ? solidPressureFactor(ss.solid.grainTemp, ss.solid.refTemp, ss.solid.piK) : 1`; `pc = ss.chamberPressure * thr * factor`.
   - **`flow-separation:i`** (propulsion). Only when `thr >= 0.5`. `state = separationState(nozzleExitPressure(pc, ss.expansionRatio, ss.gamma), d.pressure)`. Keep a per-stage timer: add `dt` while `state !== 'attached'`, reset to 0 when it is `'attached'`. Raise only when the timer is at least 1.0 s: critical for `'separated'`, warning for `'marginal'`. value = exit pressure, limit = `0.4 * d.pressure`, unit `Pa`. Fix text: the nozzle is over-expanded for this altitude; the jet detaches from the wall and shakes the engine sideways. Light this engine higher or use a smaller expansion ratio.
   - **`case-burst:i`** (pressure). Only if `ss.solid`. `dp = pc - d.pressure`; skip if `dp <= 1e5`. `fos = MATERIALS[ss.solid.caseMaterial].ultimate / hoopStress(dp, ss.solid.caseRadius, ss.solid.caseThickness)`. critical if `fos < 1.1`; warning if `fos < 1.4`. Worse = lower.
6. **Fairing vent** (pressure). Only if `spec.fairing`. On the first observe set `fairingPressure = d.pressure`.
   - While `sim.rt.fairingAttached` and `dt > 0`: `before = fairingPressure`; `fairingPressure = ventStep(before, d.pressure, dt, volume, ventArea)`; `deltaP = fairingPressure - d.pressure`.
     Depressurisation rate: keep a running window. Accumulate `(before - fairingPressure)` and `dt` until the accumulated time reaches 0.5 s, then `rate = accumulatedDrop / accumulatedTime`, store it in `channels.depressRate`, and reset the accumulators.
     **`fairing-dp`**: critical if `deltaP > maxDeltaP`; warning if `deltaP > 0.5 * maxDeltaP`. unit `Pa`. Fix: open more vent area; the trapped air is pushing the fairing outward.
     **`depress-rate`**: critical if `rate > maxDepressRate`; warning if `rate > 0.8 * maxDepressRate`. unit `Pa/s`. Fix: the payload's own vents cannot keep up with a pressure drop this fast.
   - On the step where `fairingAttached` goes from true to false:
     **`fairing-jettison-dp`** with the last `deltaP`: critical if `> 5000`; warning if `> 1000`.
     Then set `deltaP = 0` and stop integrating.
7. **`payload-heating`** (thermal). On the jettison step and on every step after it while `d.altitude < 200e3`: critical if `d.fmHeatFlux > 2 * limits.payloadHeatFlux`; warning if `d.fmHeatFlux > limits.payloadHeatFlux`. unit `W/m^2`. Fix: keep the fairing on until free-molecular heating falls below the limit.
8. **`skin-temp`** (thermal). While `sim.rt.fairingAttached` (or always, if the vehicle has no fairing) and `dt > 0`:
   `Tinf = Math.min(300, atmosphere(d.altitude).temperature)`; `Taw = recoveryTemperature(Tinf, d.mach)`; `skinTemp = skinStep(skinTemp, d.heatFlux, Taw, dt, capacity, emissivity)`. With `mat = MATERIALS[noseSkin.material]`: critical if `skinTemp > mat.maxTemp`; warning if `skinTemp > mat.warnTemp`. unit `K`. Fix: thicken the nose cap or add thermal protection.
9. **`separation-q:i`** (structure). On the step where stage `i` goes from attached to not attached, with `d.q`: critical if `> 5 * maxSeparationQ`; warning if `> maxSeparationQ`. unit `Pa`. Fix: separating in thick air risks the stages colliding; stage higher.

Update `channels` at the end of every `observe`.

Export everything from `rocket-physics\src\index.ts`: add six lines, `export * from './faults/fluids.ts';` and the same for `materials`, `pressure`, `thermal`, `spec`, `monitor`. If a name collides with an existing export, rename **your** new name, not the old one.

Check: `cd rocket-physics; npm test; cd ..` and, from the repo root, `npm run typecheck`. Commit `rocket-physics/src/faults/monitor.ts rocket-physics/src/index.ts`.

## Step A6 — fly it and pin the numbers

Create `rocket-physics\test\faultmonitor.test.ts`. Helper:

```ts
function fly(spec: FaultSpec, ascent: Partial<AscentOptions> = {}) {
  const vehicle = lvm3();
  const autopilot = new AscentAutopilot({ target: { perigeeAltitude: 170e3, apogeeAltitude: 36500e3 }, pitchKickDeg: 8, ...ascent });
  const monitor = new FaultMonitor(vehicle, spec);
  const sim = new Simulation(vehicle, { site: SITES.sriharikota, epoch: new Date('2023-07-14T09:05:17Z') }, monitored(autopilot, monitor));
  let peakSkin = 0, peakDp = 0, peakRate = 0;
  sim.run(3000, () => {
    peakSkin = Math.max(peakSkin, monitor.channels.skinTemp);
    peakDp = Math.max(peakDp, monitor.channels.fairingDeltaP);
    peakRate = Math.max(peakRate, monitor.channels.depressRate);
    return autopilot.phase === 'done' || autopilot.phase === 'aborted';
  });
  return { sim, autopilot, faults: monitor.report(), peakSkin, peakDp, peakRate };
}
```

Fly each case once at module level and reuse the result (a flight takes several seconds).

Tests on the **nominal** flight (`lvm3FaultSpec()`):

- `autopilot.reachedTarget` is true (the monitor did not disturb the flight).
- No fault has severity `'warning'` or `'critical'`. If this fails, print the offending faults in the assertion message.
- `peakSkin` is between 385 and 430 K (prototype: 407).
- `peakDp` is between 1000 and 2200 Pa (prototype: 1533).
- `peakRate` is between 1400 and 2600 Pa/s (prototype: about 1950).
- `sim.maxQ.value` is between 38000 and 45000 Pa (prototype: 41436; this is unchanged engine behaviour).
- There is a `boil-off:2:1` fault (LH2) with severity `'info'`.

Tests on scenarios. "At least warning" means severity is `'warning'` or `'critical'`.

| flight | must contain |
|---|---|
| `applyScenario(lvm3FaultSpec(), 'blocked-vent')` | `fairing-dp`, critical (prototype peak about 14900 Pa) |
| `'regulator-low'` | `cavitation:0:1` critical; `cavitation:2:1` critical; `tank-buckling:0:0` at least warning |
| `'regulator-high'` | `tank-burst:0:1` at least warning |
| `'hot-grain'` | `chamber-overpressure:1` critical |
| `'thin-nose'` | `skin-temp` critical (prototype peak 462 K) |
| `'long-hold'` | `boil-off:2:1` warning |
| nominal spec, `fly(spec, { fairingHeatFlux: 20000 })` | `payload-heating`, at least warning |

Also assert for every fault in every report: `detail` and `fix` are non-empty strings, and `value` and `limit` are finite numbers.

Record in `docs\PHYSICS-PROGRESS.md` the measured nominal `peakSkin`, `peakDp`, `peakRate`, the smallest `tank-burst` factor of safety seen for each tank (add temporary logging, then remove it; prototype: L110 UH25 1.92, L110 N2O4 1.65, C25 LOX 2.11, C25 LH2 2.52), and the full list of fault ids for each scenario.

Check: `cd rocket-physics; npm test; cd ..`. Commit the test file and the progress file.

## Step A7 — put faults on the flight record

1. `src\mission\engine.ts`: add to the value exports `FaultMonitor`, `monitored`, `lvm3FaultSpec`, `applyScenario`, `SCENARIOS`; add to the type exports `Fault`, `FaultSpec`, `ScenarioId`.
2. `src\mission\record.ts`:
   - `FlightSample`: add optional `skinTemp?: number; fairingDeltaP?: number; heatFlux?: number; ambientPressure?: number;`.
   - Add `export interface FlightFault { id: string; system: 'pressure' | 'thermal' | 'structure' | 'propulsion'; severity: 'info' | 'warning' | 'critical'; stage?: number; t: number; value: number; limit: number; unit: string; title: string; detail: string; fix: string }`.
   - `FlightRecord`: add optional `faults?: FlightFault[];` and `scenario?: string;`.
3. `src\mission\vehicles.ts`: add optional `faults?: () => FaultSpec` to `MissionDef`, and set `faults: () => lvm3FaultSpec()` on `lvm3-m4`.
4. `src\mission\fly.ts`:
   - `FlyOptions` gains `scenario?: ScenarioId`.
   - If `def.faults` exists: `spec = def.faults()`, apply the scenario if one was given, build a `FaultMonitor`, and pass `monitored(autopilot, monitor)` to `new Simulation(...)` instead of `autopilot`. Keep using the inner `autopilot` for the `phase` and `reachedTarget` reads.
   - On each pushed sample set `skinTemp`, `fairingDeltaP` from `monitor.channels`, and `heatFlux = sim.diag.heatFlux`, `ambientPressure = sim.diag.pressure`.
   - After the loop: `faults = monitor.report()`. Put them on the record. For each fault also append a marker `{ t: fault.t, kind: 'flaw', label: fault.title, severity: fault.severity }`, then sort `markers` by `t` (stable).
   - If `def.faults` is absent, behave exactly as before.
5. `src\mission\fly.test.ts`: add tests. The nominal `lvm3-m4` record has `faults` defined with no warning or critical entry; `samples` have finite `skinTemp`; `reachedTarget` is still true. `flyMission(def, { scenario: 'thin-nose' })` has a critical `skin-temp` fault and a marker with `kind === 'flaw'`. `JSON.stringify(record)` still round-trips.
6. Update the contract block in `docs\SYSTEM_DESIGN.md` to show the new optional fields.

Do not touch `src\mission\worker.ts`, `client.ts` or anything in `src\app\`.

Check: `npm run typecheck`, `npm test` (349 + your new tests, 0 failed), `npm run build`.
Commit only: `src/mission/engine.ts src/mission/record.ts src/mission/vehicles.ts src/mission/fly.ts src/mission/fly.test.ts docs/SYSTEM_DESIGN.md docs/PHYSICS-PROGRESS.md`.

**If every Part A check is green, go on to Part B. If not, stop here.**

---

# Part B — model-rocket design review (`src\physics\envFlaws.ts`)

Three new rules for the builder's flaw report: aerodynamic heating, airframe crushing, fin root bending. They read the recorded flight log only. They are tuned so an ordinary small model rocket triggers none of them.

Read first: `src\physics\flaws.ts`, `src\physics\flaws.test.ts`, `src\types.ts` (`SimState`, `Flaw`, the component types), `src\physics\atmosphere.ts`.

## Step B1 — the rules

Create `src\physics\envFlaws.ts`:

```ts
export interface AirframeMaterial { name: string; youngsModulus: number; compressive: number; bending: number; maxTemp: number }
export function materialFromDensity(density: number): AirframeMaterial | null
```

| density (kg/m^3) | name | youngsModulus | compressive | bending | maxTemp |
|---|---|---|---|---|---|
| `<= 0` or not finite | return `null` | | | | |
| `< 300` | balsa | 3.0e9 | 7e6 | 20e6 | 450 |
| `< 900` | paper or plywood | 2.5e9 | 8e6 | 40e6 | 450 |
| `< 1400` | plastic | 2.5e9 | 40e6 | 50e6 | 330 |
| otherwise | composite | 15e9 | 150e6 | 250e6 | 400 |

Pure helpers, exported:

- `recoveryTemp(Tinf, mach)` → `Tinf * (1 + 0.178 * mach * mach)`.
- `tubeCrushLoad(outerRadius, thickness, mat)` → `r = outerRadius - thickness / 2`; `g = 1 - 0.901 * (1 - Math.exp(-Math.sqrt(r / thickness) / 16))`; `sigma = Math.min(g * 0.605 * mat.youngsModulus * thickness / r, mat.compressive)`; return `sigma * 2 * Math.PI * r * thickness`. Newtons.
- `finRootStress(qAlpha, span, rootChord, tipChord, thickness)` → `S = span * (rootChord + tipChord) / 2`; `AR = 2 * span * span / S`; `cn = 2 * Math.PI * AR / (2 + Math.sqrt(4 + AR * AR))`; `lambda = tipChord / rootChord`; `arm = span * (1 + 2 * lambda) / (3 * (1 + lambda))`; return `6 * qAlpha * S * cn * arm / (rootChord * thickness * thickness)`. Pascals. Return 0 if any input is `<= 0` except `tipChord`, which may be 0.
- `ejectionChargeMass(volume, targetPressure = 103e3)` → `targetPressure * volume / 2.19e5`. Kilograms of black powder (gas constant 119.3 J/(kg K) at 1837 K). Helper only; no rule uses it yet.

`export function analyzeEnvironment(sim: { log: SimState[]; events: FlightEvent[] }, rocket: RocketModel, config: SimConfig): Flaw[]`:

1. **`aero-heating:<component id>`** for each `nosecone` and `finset` whose `materialFromDensity(c.density)` is not null. Walk the log. For each sample `Tr = recoveryTemp(atmosphere(config.launchAltitude + s.altitude).temperature, s.mach)`. Track the peak `Tr`, its time, and the total time with `Tr > mat.maxTemp` (sum of `log[i].t - log[i-1].t` for samples above the limit). If the peak exceeds `mat.maxTemp`: severity `critical` when the time above is at least 1.0 s, else `warning`. Title `Aerodynamic heating: <name>`. Detail gives the peak temperature in °C, the Mach number at that moment, the material name and its limit in °C. Fix: use a fibreglass or metal-tipped part, or fly slower. value = peak K, limit = `mat.maxTemp`, unit `K`.
2. **`airframe-crush:<component id>`** for each `bodytube` with `thickness > 0` and a non-null material. `load = max over the log of s.thrust`. `util = load / tubeCrushLoad(c.outerRadius, c.thickness, mat)`. critical if `util > 1`; warning if `util > 0.5`. Detail gives the peak thrust and the tube's crush load in newtons. Fix: thicker wall, a stiffer tube, or a lower-thrust motor. value = load, limit = crush load, unit `N`.
3. **`fin-root-bending:<component id>`** for each `finset` with a non-null material. `qAlpha = max over samples with phase 'boost' or 'coast' of s.dynamicPressure * Math.min(s.alpha, 0.26)`. `util = finRootStress(qAlpha, c.span, c.rootChord, c.tipChord, c.thickness) / mat.bending`. critical if `util > 1`; warning if `util > 0.5`. Detail gives the stress and the strength in MPa. Fix: thicker fins, shorter span, or a stronger material. value = stress, limit = strength, unit `Pa`.

Return the list unsorted.

Create `src\physics\envFlaws.test.ts` (Vitest, same style as `flaws.test.ts`). Build synthetic logs with a small helper that returns a full `SimState` from a few overrides.

| test | expected |
|---|---|
| `materialFromDensity(0)` | `null` |
| `materialFromDensity(130).name` | `'balsa'` |
| `materialFromDensity(680).name` | `'paper or plywood'` |
| `materialFromDensity(1250).maxTemp` | 330 |
| `materialFromDensity(1850).name` | `'composite'` |
| `recoveryTemp(288.15, 1)` | 339.44, within 0.01 |
| `tubeCrushLoad(0.0125, 0.0005, materialFromDensity(680)!)` | between 300 and 320 N (the 8 MPa crush strength governs: `8e6 * 2π * 0.01225 * 0.0005` = 307.9) |
| `finRootStress(1000, 0.04, 0.05, 0.025, 0.003)` | 967 900 Pa, within 0.5 % |
| `finRootStress(1000, 0.04, 0.05, 0.025, 0)` | 0 |
| `ejectionChargeMass(3.7e-3)` | 1.740e-3 kg, within 0.5 % |
| `analyzeEnvironment` on a real flight of `FIXTURE_ROCKET` with `FIXTURE_MOTOR` (build the sim the way `flaws.test.ts` or `sim.test.ts` does) | empty array |
| synthetic log: plastic nose (density 1250), 30 samples 0.1 s apart at Mach 1.2, altitude 500 | one `aero-heating:` flaw, `critical` |
| same but only 3 samples at Mach 1.2, the rest at Mach 0.3 | `warning` |
| synthetic log with `thrust: 400` and a paper tube r 0.0125, t 0.0005 | `airframe-crush:` flaw, `critical` |
| synthetic log, phase `'boost'`, `dynamicPressure: 60000`, `alpha: 0.2`, balsa fins span 0.04, root 0.05, tip 0.025, thickness 0.001 | `fin-root-bending:` flaw, `critical` |

Check: `npm run typecheck`; `npx vitest run src/physics/envFlaws.test.ts`.
Commit `src/physics/envFlaws.ts src/physics/envFlaws.test.ts`.

## Step B2 — join the existing report

In `src\physics\flaws.ts`, in `analyzeFlight`, immediately before the final `return flaws.sort(...)` line, add `flaws.push(...analyzeEnvironment(sim, rocket, config));` and the import. Change nothing else in that file.

Check: `npm run typecheck`, then `npm test`. **Every test that passed before must still pass.** If an existing test now fails because one of your rules fires on a rocket that test treats as healthy, do not edit that test and do not change a threshold: remove the line you added to `flaws.ts`, record the failing test name and the flaw that fired (id, value, limit) in the progress file, and stop.

Then `npm run build`.
Commit `src/physics/flaws.ts docs/PHYSICS-PROGRESS.md`.

---

# Finish

Append a summary to `docs\PHYSICS-PROGRESS.md`:

- final test counts for both suites,
- the table of nominal LVM3 numbers from Step A6,
- which scenarios produce which fault ids,
- anything in this prompt that did not match the code you found,
- anything you could not do.

Commit it. Do not push. End the session.

## Not in this session (do not start these)

A mission-mode screen or fault panel; ending the flight when a critical fault fires; thrust that changes with grain temperature; unsettled propellant at upper-stage ignition; engine cooling (Bartz) limits; base heating; pogo; fault specs for vehicles other than LVM3.
