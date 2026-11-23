// Launch-day weather from Open-Meteo (https://open-meteo.com, no API key).
//
// Three sources, picked from how far the launch date is from today:
//   forecast     the hourly forecast, for dates from about two months back to two weeks ahead
//   record       what actually happened, for older dates (ERA5 reanalysis archive)
//   climatology  the same calendar day averaged over the last five years, for dates the
//                forecast cannot reach yet
//
// Only the launch site's coordinates and the date are sent. Wind speeds are m/s, directions
// are the compass bearing the wind blows FROM, in degrees.

import type { SimConfig, WindLayer } from '../types';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** The forecast API reaches 16 days ahead and about 3 months back; stay inside both. */
const FORECAST_DAYS_AHEAD = 14;
const FORECAST_DAYS_BACK = 60;
const CLIMATOLOGY_YEARS = 5;
const RAD_PER_DEG = Math.PI / 180;

export interface LaunchSiteInfo {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/** Ranges used by student and amateur teams, plus the two Indian sounding-rocket sites. */
export const LAUNCH_SITES: LaunchSiteInfo[] = [
  { id: 'sdsc', name: 'Sriharikota, India', latitude: 13.72, longitude: 80.23 },
  { id: 'terls', name: 'Thumba, India', latitude: 8.53, longitude: 76.87 },
  { id: 'spaceport-america', name: 'Spaceport America, USA', latitude: 32.99, longitude: -106.97 },
  { id: 'far-mojave', name: 'FAR site, Mojave, USA', latitude: 35.35, longitude: -117.81 },
  { id: 'black-rock', name: 'Black Rock Desert, USA', latitude: 40.87, longitude: -119.06 },
  { id: 'cape', name: 'Cape Canaveral, USA', latitude: 28.56, longitude: -80.58 },
];

export type WeatherSource = 'forecast' | 'record' | 'climatology';

export interface WindAloft {
  /** Height above the launch site, m. */
  altitude: number;
  speed: number;
  fromDeg: number;
}

export interface LaunchWeather {
  source: WeatherSource;
  /** YYYY-MM-DD, local to the site. */
  date: string;
  /** Local hour at the site, 0..23. */
  hour: number;
  /** Years averaged, for climatology. */
  years?: number;
  temperatureC: number;
  /** Station pressure at the site, hPa. */
  pressureHpa: number | null;
  /** Surface (10 m) wind. */
  windSpeed: number;
  windFromDeg: number;
  gustSpeed: number | null;
  cloudCover: number | null;
  lowCloudCover: number | null;
  /** Chance of rain or snow in the launch hour, percent. */
  precipChance: number | null;
  visibilityM: number | null;
  /** WMO weather code, when the source gives one. */
  weatherCode: number | null;
  /** Winds above 10 m, lowest first. */
  aloft: WindAloft[];
}

export type Verdict = 'go' | 'caution' | 'no-go';

export interface LaunchAssessment {
  verdict: Verdict;
  /** Plain-language reasons, most serious first. Empty when the verdict is 'go'. */
  reasons: string[];
}

export interface FetchWeatherOptions {
  fetchFn?: typeof fetch;
  /** Overrides the current date (tests). */
  today?: Date;
  signal?: AbortSignal;
}

// ---------- Dates ----------

/** Today's date as YYYY-MM-DD in the device's own time zone. */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function parseIso(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Whole days from `today` to `date` (negative for the past). NaN for a malformed date. */
export function daysFromToday(date: string, today: Date = new Date()): number {
  const p = parseIso(date);
  if (!p) return NaN;
  const a = Date.UTC(p.y, p.m - 1, p.d);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86_400_000);
}

export function sourceForDate(date: string, today: Date = new Date()): WeatherSource {
  const days = daysFromToday(date, today);
  if (days > FORECAST_DAYS_AHEAD) return 'climatology';
  if (days < -FORECAST_DAYS_BACK) return 'record';
  return 'forecast';
}

/** The same calendar day in each of the last `count` complete years before `date` and today. */
export function climatologyDates(date: string, today: Date = new Date(), count = CLIMATOLOGY_YEARS): string[] {
  const p = parseIso(date);
  if (!p) return [];
  const out: string[] = [];
  // Start from the latest year whose copy of this day is safely in the archive.
  let year = Math.min(p.y, today.getFullYear()) - 1;
  for (let i = 0; i < count; i++, year--) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const day = p.m === 2 && p.d === 29 && !leap ? 28 : p.d;
    out.push(`${year}-${String(p.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return out;
}

// ---------- Requests ----------

const FORECAST_HOURLY = [
  'temperature_2m', 'surface_pressure', 'precipitation_probability', 'precipitation',
  'cloud_cover', 'cloud_cover_low', 'visibility', 'weather_code',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'wind_speed_80m', 'wind_direction_80m',
  'wind_speed_120m', 'wind_direction_120m',
  'wind_speed_180m', 'wind_direction_180m',
  'wind_speed_925hPa', 'wind_direction_925hPa', 'geopotential_height_925hPa',
  'wind_speed_850hPa', 'wind_direction_850hPa', 'geopotential_height_850hPa',
  'wind_speed_700hPa', 'wind_direction_700hPa', 'geopotential_height_700hPa',
];

const ARCHIVE_HOURLY = [
  'temperature_2m', 'surface_pressure', 'precipitation', 'cloud_cover', 'cloud_cover_low',
  'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'wind_speed_100m', 'wind_direction_100m',
];

export function buildUrl(kind: 'forecast' | 'archive', site: LaunchSiteInfo, date: string): string {
  const q = new URLSearchParams({
    latitude: site.latitude.toFixed(2),
    longitude: site.longitude.toFixed(2),
    hourly: (kind === 'forecast' ? FORECAST_HOURLY : ARCHIVE_HOURLY).join(','),
    wind_speed_unit: 'ms',
    timezone: 'auto',
    start_date: date,
    end_date: date,
  });
  return `${kind === 'forecast' ? FORECAST_URL : ARCHIVE_URL}?${q.toString()}`;
}

interface ApiResponse {
  elevation?: number;
  hourly?: Record<string, (number | null)[] | string[]>;
  error?: boolean;
  reason?: string;
}

async function getJson(url: string, opts: FetchWeatherOptions): Promise<ApiResponse> {
  const f = opts.fetchFn ?? fetch;
  const res = await f(url, { signal: opts.signal });
  const json = (await res.json()) as ApiResponse;
  if (!res.ok || json.error) throw new Error(json.reason ?? `Weather service returned ${res.status}`);
  return json;
}

/** Day responses are cached so changing only the launch hour does not refetch. */
const dayCache = new Map<string, Promise<ApiResponse>>();

function getDay(url: string, opts: FetchWeatherOptions): Promise<ApiResponse> {
  if (opts.fetchFn) return getJson(url, opts); // injected fetch: never cached
  let p = dayCache.get(url);
  if (!p) {
    p = getJson(url, opts);
    dayCache.set(url, p);
    p.catch(() => dayCache.delete(url));
  }
  return p;
}

// ---------- Parsing ----------

function value(json: ApiResponse, name: string, hour: number): number | null {
  const v = json.hourly?.[name]?.[hour];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readAloft(json: ApiResponse, hour: number): WindAloft[] {
  const out: WindAloft[] = [];
  const add = (altitude: number | null, tag: string): void => {
    const speed = value(json, `wind_speed_${tag}`, hour);
    const fromDeg = value(json, `wind_direction_${tag}`, hour);
    if (altitude === null || speed === null || fromDeg === null) return;
    out.push({ altitude, speed, fromDeg });
  };
  for (const h of [80, 100, 120, 180]) add(h, `${h}m`);
  const elevation = typeof json.elevation === 'number' ? json.elevation : 0;
  for (const level of [925, 850, 700]) {
    const gh = value(json, `geopotential_height_${level}hPa`, hour);
    // A pressure level at or below the terrain is not real air.
    add(gh !== null && gh - elevation > 250 ? gh - elevation : null, `${level}hPa`);
  }
  out.sort((a, b) => a.altitude - b.altitude);
  return out.filter((l, i) => i === 0 || l.altitude > out[i - 1].altitude);
}

function parseHour(json: ApiResponse, source: WeatherSource, date: string, hour: number): LaunchWeather | null {
  const temperatureC = value(json, 'temperature_2m', hour);
  const windSpeed = value(json, 'wind_speed_10m', hour);
  const windFromDeg = value(json, 'wind_direction_10m', hour);
  if (temperatureC === null || windSpeed === null || windFromDeg === null) return null;

  let precipChance = value(json, 'precipitation_probability', hour);
  if (precipChance === null) {
    // The archive has amounts, not chances: a wet hour is 100 %, a dry one 0 %.
    const mm = value(json, 'precipitation', hour);
    if (mm !== null) precipChance = mm >= 0.1 ? 100 : 0;
  }
  return {
    source,
    date,
    hour,
    temperatureC,
    pressureHpa: value(json, 'surface_pressure', hour),
    windSpeed,
    windFromDeg,
    gustSpeed: value(json, 'wind_gusts_10m', hour),
    cloudCover: value(json, 'cloud_cover', hour),
    lowCloudCover: value(json, 'cloud_cover_low', hour),
    precipChance,
    visibilityM: value(json, 'visibility', hour),
    weatherCode: value(json, 'weather_code', hour),
    aloft: readAloft(json, hour),
  };
}

function mean(xs: (number | null)[]): number | null {
  const ok = xs.filter((x): x is number => x !== null);
  return ok.length > 0 ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

/** Mean wind: scalar-mean speed, vector-mean direction. */
function meanWind(samples: { speed: number; fromDeg: number }[]): { speed: number; fromDeg: number } {
  let e = 0;
  let n = 0;
  let s = 0;
  for (const w of samples) {
    e += w.speed * Math.sin(w.fromDeg * RAD_PER_DEG);
    n += w.speed * Math.cos(w.fromDeg * RAD_PER_DEG);
    s += w.speed;
  }
  const fromDeg = Math.hypot(e, n) > 1e-9 ? (Math.atan2(e, n) / RAD_PER_DEG + 360) % 360 : samples[0]?.fromDeg ?? 0;
  return { speed: samples.length > 0 ? s / samples.length : 0, fromDeg };
}

/** Average the same hour over several years into one typical day. */
export function averageYears(samples: LaunchWeather[], date: string, hour: number): LaunchWeather {
  const surface = meanWind(samples.map((w) => ({ speed: w.windSpeed, fromDeg: w.windFromDeg })));
  // Winds aloft: average the levels every year reported, matched by index.
  const levels = Math.min(...samples.map((w) => w.aloft.length));
  const aloft: WindAloft[] = [];
  for (let i = 0; i < levels; i++) {
    const w = meanWind(samples.map((s) => ({ speed: s.aloft[i].speed, fromDeg: s.aloft[i].fromDeg })));
    aloft.push({ altitude: mean(samples.map((s) => s.aloft[i].altitude)) ?? 0, ...w });
  }
  return {
    source: 'climatology',
    date,
    hour,
    years: samples.length,
    temperatureC: mean(samples.map((w) => w.temperatureC)) ?? 15,
    pressureHpa: mean(samples.map((w) => w.pressureHpa)),
    windSpeed: surface.speed,
    windFromDeg: surface.fromDeg,
    gustSpeed: mean(samples.map((w) => w.gustSpeed)),
    cloudCover: mean(samples.map((w) => w.cloudCover)),
    lowCloudCover: mean(samples.map((w) => w.lowCloudCover)),
    precipChance: mean(samples.map((w) => w.precipChance)),
    visibilityM: null,
    weatherCode: null,
    aloft,
  };
}

// ---------- Fetch ----------

async function fetchClimatology(
  site: LaunchSiteInfo, date: string, hour: number, opts: FetchWeatherOptions,
): Promise<LaunchWeather> {
  const days = climatologyDates(date, opts.today);
  const settled = await Promise.allSettled(
    days.map(async (d) => parseHour(await getDay(buildUrl('archive', site, d), opts), 'record', d, hour)),
  );
  const samples: LaunchWeather[] = [];
  for (const r of settled) if (r.status === 'fulfilled' && r.value) samples.push(r.value);
  if (samples.length === 0) throw new Error('No past weather is available for this site and day.');
  return averageYears(samples, date, hour);
}

/**
 * Weather at `site` on `date` (YYYY-MM-DD) at local `hour`. Rejects on a network failure,
 * a malformed date, or when the service has nothing for that day.
 */
export async function fetchLaunchWeather(
  site: LaunchSiteInfo, date: string, hour: number, opts: FetchWeatherOptions = {},
): Promise<LaunchWeather> {
  if (!parseIso(date)) throw new Error('Pick a valid launch date.');
  const h = Math.min(23, Math.max(0, Math.round(hour)));
  const source = sourceForDate(date, opts.today);
  if (source === 'climatology') return fetchClimatology(site, date, h, opts);
  const kind = source === 'forecast' ? 'forecast' : 'archive';
  try {
    const parsed = parseHour(await getDay(buildUrl(kind, site, date), opts), source, date, h);
    if (parsed) return parsed;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    // Fall through to the typical-day estimate.
  }
  return fetchClimatology(site, date, h, opts);
}

// ---------- Interpretation ----------

/** Short sky description from the WMO code, or from cloud and rain when there is no code. */
export function describeSky(w: LaunchWeather): string {
  const c = w.weatherCode;
  if (c !== null) {
    if (c >= 95) return 'Thunderstorm';
    if (c >= 85) return 'Snow showers';
    if (c >= 80) return 'Rain showers';
    if (c >= 71 && c <= 77) return 'Snow';
    if (c >= 61 && c <= 67) return 'Rain';
    if (c >= 51 && c <= 57) return 'Drizzle';
    if (c === 45 || c === 48) return 'Fog';
    if (c === 3) return 'Overcast';
    if (c === 2) return 'Partly cloudy';
    if (c === 1) return 'Mostly clear';
    if (c === 0) return 'Clear';
  }
  if ((w.precipChance ?? 0) >= 50) return 'Often wet';
  const cloud = w.cloudCover ?? 0;
  if (cloud >= 80) return 'Usually overcast';
  if (cloud >= 40) return 'Partly cloudy';
  return 'Mostly clear';
}

/**
 * Limits for model and high-power rockets, the kind a college team flies. They follow the
 * NAR and Tripoli safety codes: no launch in wind above 20 mph (8.9 m/s), into cloud, or
 * with a storm nearby.
 */
export const SMALL_ROCKET_LIMITS = {
  windNoGo: 8.9,
  windCaution: 6.5,
  gustNoGo: 13,
  gustCaution: 9,
  precipCaution: 40,
  precipNoGo: 70,
  lowCloudCaution: 60,
  visibilityCaution: 5000,
} as const;

export function assessLaunch(w: LaunchWeather): LaunchAssessment {
  const L = SMALL_ROCKET_LIMITS;
  const stop: string[] = [];
  const warn: string[] = [];
  const gust = w.gustSpeed ?? 0;

  if (w.weatherCode !== null && w.weatherCode >= 95) stop.push('Thunderstorm at the site.');
  if (w.windSpeed >= L.windNoGo) {
    stop.push(`Wind ${w.windSpeed.toFixed(1)} m/s is over the 8.9 m/s (20 mph) safety-code limit.`);
  } else if (w.windSpeed >= L.windCaution) {
    warn.push(`Wind ${w.windSpeed.toFixed(1)} m/s is close to the 8.9 m/s limit; expect a long drift.`);
  }
  if (gust >= L.gustNoGo) stop.push(`Gusts reach ${gust.toFixed(1)} m/s.`);
  else if (gust >= L.gustCaution) warn.push(`Gusts reach ${gust.toFixed(1)} m/s; the rocket may weathercock off the rail.`);

  const precip = w.precipChance ?? 0;
  if (precip >= L.precipNoGo) stop.push(`${Math.round(precip)} % chance of rain.`);
  else if (precip >= L.precipCaution) warn.push(`${Math.round(precip)} % chance of rain.`);

  const low = w.lowCloudCover ?? (w.cloudCover !== null && w.cloudCover >= 95 ? w.cloudCover : 0);
  if (low >= L.lowCloudCaution) warn.push(`Low cloud covers ${Math.round(low)} % of the sky; do not fly into cloud.`);
  if (w.visibilityM !== null && w.visibilityM < L.visibilityCaution) {
    warn.push(`Visibility is ${(w.visibilityM / 1000).toFixed(1)} km.`);
  }

  if (stop.length > 0) return { verdict: 'no-go', reasons: [...stop, ...warn] };
  if (warn.length > 0) return { verdict: 'caution', reasons: warn };
  return { verdict: 'go', reasons: [] };
}

/** The launch-settings fields this weather fills in. */
export type WeatherConfig = Pick<
  SimConfig,
  'windSpeed' | 'windDirection' | 'gust' | 'groundTemperature' | 'groundPressure' | 'windLayers'
>;

export function weatherToConfig(w: LaunchWeather): WeatherConfig {
  const gust =
    w.gustSpeed !== null && w.windSpeed > 0.1
      ? Math.min(1, Math.max(0, (w.gustSpeed - w.windSpeed) / w.windSpeed))
      : 0;
  const windLayers: WindLayer[] = w.aloft.map((l) => ({
    altitude: l.altitude,
    speed: l.speed,
    direction: l.fromDeg * RAD_PER_DEG,
  }));
  return {
    windSpeed: w.windSpeed,
    windDirection: w.windFromDeg * RAD_PER_DEG,
    gust,
    groundTemperature: w.temperatureC + 273.15,
    groundPressure: w.pressureHpa !== null ? w.pressureHpa * 100 : undefined,
    windLayers: windLayers.length > 0 ? windLayers : undefined,
  };
}
