// Wind and local air for the launch site.
//
// World frame at the pad: +X east, +Z south. A wind FROM compass bearing d moves the air
// toward the opposite bearing, so its velocity is [-sin d, 0, cos d] * speed.

import type { Atmosphere, AtmosphereFn, SimConfig, Vec3, WindLayer } from '../types';

const R_AIR = 287.053;
const GAMMA = 1.4;
/** Height of the surface wind measurement, m. */
const SURFACE_HEIGHT = 10;
/** The measured ground offset fades out between these heights above the site, m. */
const FADE_START = 11_000;
const FADE_END = 20_000;

type WindConfig = Pick<SimConfig, 'windSpeed' | 'windDirection' | 'gust' | 'windLayers'>;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Air velocity at `altitude` above the site at time `t`.
 *
 * Without winds aloft the surface wind follows a 1/7-style power law. With `windLayers` the
 * surface wind is the 10 m layer and the wind is interpolated between layers (east and south
 * components separately, so the direction turns smoothly), then held above the top layer.
 */
export function windVector(config: WindConfig, altitude: number, t: number): Vec3 {
  if (altitude <= 0) return [0, 0, 0];
  const layers = config.windLayers;
  const hasLayers = layers !== undefined && layers.length > 0;
  if (config.windSpeed === 0 && !hasLayers) return [0, 0, 0];

  const gust = 1 + config.gust * Math.sin(1.7 * t) * Math.sin(0.31 * t + 1);
  const surfaceDir = config.windDirection;

  if (!hasLayers || altitude <= SURFACE_HEIGHT) {
    const cap = hasLayers ? 1 : 2;
    const profile = clamp(Math.pow(altitude / SURFACE_HEIGHT, 0.14), 0, cap);
    const s = config.windSpeed * gust * profile;
    return [-Math.sin(surfaceDir) * s, 0, Math.cos(surfaceDir) * s];
  }

  let below: WindLayer = { altitude: SURFACE_HEIGHT, speed: config.windSpeed, direction: surfaceDir };
  let above: WindLayer | null = null;
  for (const l of layers) {
    if (l.altitude <= below.altitude) continue;
    if (altitude <= l.altitude) {
      above = l;
      break;
    }
    below = l;
  }
  const bx = -Math.sin(below.direction) * below.speed;
  const bz = Math.cos(below.direction) * below.speed;
  if (!above) return [bx * gust, 0, bz * gust];
  const u = (altitude - below.altitude) / (above.altitude - below.altitude);
  const ax = -Math.sin(above.direction) * above.speed;
  const az = Math.cos(above.direction) * above.speed;
  return [(bx + (ax - bx) * u) * gust, 0, (bz + (az - bz) * u) * gust];
}

/**
 * The standard atmosphere shifted to match the temperature and pressure measured at the site.
 * Density and speed of sound follow, so a hot or high site gives thinner air, less drag and a
 * different Mach number for the same airspeed. Returns `std` unchanged when nothing is set.
 *
 * `std` takes altitude above the mean radius; `config.launchAltitude` is the site's.
 */
export function siteAtmosphere(
  std: AtmosphereFn,
  config: Pick<SimConfig, 'launchAltitude' | 'groundTemperature' | 'groundPressure'>,
): AtmosphereFn {
  const { groundTemperature, groundPressure, launchAltitude } = config;
  const hasT = groundTemperature !== undefined && Number.isFinite(groundTemperature) && groundTemperature > 0;
  const hasP = groundPressure !== undefined && Number.isFinite(groundPressure) && groundPressure > 0;
  if (!hasT && !hasP) return std;

  const base = std(launchAltitude);
  const dT = hasT ? (groundTemperature as number) - base.temperature : 0;
  const pRatio = hasP && base.pressure > 0 ? (groundPressure as number) / base.pressure : 1;

  return (altitude: number): Atmosphere => {
    const a = std(altitude);
    const fade = clamp(1 - (altitude - launchAltitude - FADE_START) / (FADE_END - FADE_START), 0, 1);
    if (fade === 0) return a;
    const temperature = a.temperature + dT * fade;
    if (!(temperature > 0)) return a;
    const pressure = a.pressure * (1 + (pRatio - 1) * fade);
    return {
      temperature,
      pressure,
      rho: pressure / (R_AIR * temperature),
      soundSpeed: Math.sqrt(GAMMA * R_AIR * temperature),
    };
  };
}

/**
 * Same air velocity as `windVector`, written into `out` without allocating. Built once per
 * flight: the surface-wind direction trig is hoisted and the gust factor is reused while the
 * time is unchanged (the RK4 mid-point stages share one time). Winds aloft are delegated.
 */
export function makeWindInto(config: WindConfig): (out: Vec3, altitude: number, t: number) => void {
  const layers = config.windLayers;
  if (layers !== undefined && layers.length > 0) {
    return (out, altitude, t) => {
      const w = windVector(config, altitude, t);
      out[0] = w[0];
      out[1] = w[1];
      out[2] = w[2];
    };
  }
  const windSpeed = config.windSpeed;
  const gustAmp = config.gust;
  const negSin = -Math.sin(config.windDirection);
  const cosDir = Math.cos(config.windDirection);
  let gustT = NaN;
  let gust = 0;
  return (out, altitude, t) => {
    if (altitude <= 0 || windSpeed === 0) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      return;
    }
    if (t !== gustT) {
      gust = 1 + gustAmp * Math.sin(1.7 * t) * Math.sin(0.31 * t + 1);
      gustT = t;
    }
    const profile = clamp(Math.pow(altitude / SURFACE_HEIGHT, 0.14), 0, 2);
    const s = windSpeed * gust * profile;
    out[0] = negSin * s;
    out[1] = 0;
    out[2] = cosDir * s;
  };
}
