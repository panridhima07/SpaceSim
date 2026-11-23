// Memoises the expensive mass and aero functions. The sim evaluates them four
// times per 2 ms step, but they only change with burn time, Mach and CG, so
// quantising the inputs (1 ms, Mach 0.0005, 10 µm) makes nearly every call a hit.
import type { AeroProps, MassProps, Motor, PhysicsDeps, RocketModel } from '../types';

const MAX_ENTRIES = 50_000;

export function cachedDeps(deps: PhysicsDeps): PhysicsDeps {
  let rocketRef: RocketModel | null = null;
  let motorRef: Motor | null = null;
  const mass = new Map<number, MassProps>();
  const aero = new Map<number, AeroProps>();
  // The four RK4 stages of a step mostly land on the same quantised key, so check the last hit first.
  let lastMassKey = NaN;
  let lastMass: MassProps | undefined;
  let lastAeroKey = NaN;
  let lastAero: AeroProps | undefined;

  const reset = (rocket: RocketModel, motor: Motor | null): void => {
    rocketRef = rocket;
    motorRef = motor;
    mass.clear();
    aero.clear();
    lastMassKey = NaN;
    lastMass = undefined;
    lastAeroKey = NaN;
    lastAero = undefined;
  };

  return {
    atmosphere: deps.atmosphere,
    thrust: deps.thrust,
    massProps(rocket, motor, tBurn) {
      if (rocket !== rocketRef || motor !== motorRef) reset(rocket, motor);
      const burn = motor ? motor.burnTime : 0;
      const t = tBurn <= 0 ? 0 : Math.min(tBurn, burn);
      const key = Math.round(t * 1000);
      if (key === lastMassKey && lastMass) return lastMass;
      let v = mass.get(key);
      if (!v) {
        if (mass.size > MAX_ENTRIES) mass.clear();
        v = deps.massProps(rocket, motor, key / 1000);
        mass.set(key, v);
      }
      lastMassKey = key;
      lastMass = v;
      return v;
    },
    aeroProps(rocket, mach, cgX) {
      if (rocket !== rocketRef) reset(rocket, motorRef);
      const m = Math.round(mach * 2000);
      const c = Math.round(cgX * 1e5);
      const key = m * 1e6 + c;
      if (key === lastAeroKey && lastAero) return lastAero;
      let v = aero.get(key);
      if (!v) {
        if (aero.size > MAX_ENTRIES) aero.clear();
        v = deps.aeroProps(rocket, m / 2000, c / 1e5);
        aero.set(key, v);
      }
      lastAeroKey = key;
      lastAero = v;
      return v;
    },
  };
}
