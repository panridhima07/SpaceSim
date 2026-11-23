import { describe, it, expect, vi } from 'vitest';
import {
  LAUNCH_SITES,
  assessLaunch,
  averageYears,
  buildUrl,
  climatologyDates,
  daysFromToday,
  describeSky,
  fetchLaunchWeather,
  sourceForDate,
  weatherToConfig,
  type LaunchWeather,
} from './launchWeather';

const TODAY = new Date(2026, 10, 22); // 22 Nov 2026, local
const SITE = LAUNCH_SITES[0];

const weather = (over: Partial<LaunchWeather> = {}): LaunchWeather => ({
  source: 'forecast',
  date: '2026-11-25',
  hour: 10,
  temperatureC: 25,
  pressureHpa: 1010,
  windSpeed: 3,
  windFromDeg: 90,
  gustSpeed: 4.5,
  cloudCover: 20,
  lowCloudCover: 5,
  precipChance: 5,
  visibilityM: 20000,
  weatherCode: 1,
  aloft: [],
  ...over,
});

/** A one-day hourly response where every listed variable holds `v` for all 24 hours. */
function day(vars: Record<string, number | null>, elevation = 8): unknown {
  const hourly: Record<string, (number | null)[]> = {};
  for (const [k, v] of Object.entries(vars)) hourly[k] = Array.from({ length: 24 }, () => v);
  return { elevation, hourly };
}

function fakeFetch(handler: (url: string) => unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const body = handler(String(input));
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe('dates', () => {
  it('counts whole days from today', () => {
    expect(daysFromToday('2026-11-22', TODAY)).toBe(0);
    expect(daysFromToday('2026-11-25', TODAY)).toBe(3);
    expect(daysFromToday('2026-11-01', TODAY)).toBe(-21);
    expect(daysFromToday('2026-02-30', TODAY)).toBeNaN();
  });

  it('picks the source from the distance to today', () => {
    expect(sourceForDate('2026-11-25', TODAY)).toBe('forecast');
    expect(sourceForDate('2026-10-20', TODAY)).toBe('forecast');
    expect(sourceForDate('2027-03-10', TODAY)).toBe('climatology');
    expect(sourceForDate('2024-06-01', TODAY)).toBe('record');
  });

  it('lists the same day in the five years before', () => {
    expect(climatologyDates('2027-03-10', TODAY)).toEqual([
      '2025-03-10', '2024-03-10', '2023-03-10', '2022-03-10', '2021-03-10',
    ]);
    // 29 February falls back to the 28th outside leap years.
    expect(climatologyDates('2028-02-29', TODAY).slice(0, 3)).toEqual([
      '2025-02-28', '2024-02-29', '2023-02-28',
    ]);
  });
});

describe('buildUrl', () => {
  it('asks for one day in m/s at the site', () => {
    const url = new URL(buildUrl('forecast', SITE, '2026-11-25'));
    expect(url.host).toBe('api.open-meteo.com');
    expect(url.searchParams.get('latitude')).toBe('13.72');
    expect(url.searchParams.get('start_date')).toBe('2026-11-25');
    expect(url.searchParams.get('end_date')).toBe('2026-11-25');
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(url.searchParams.get('hourly')).toContain('wind_speed_850hPa');
    expect(new URL(buildUrl('archive', SITE, '2024-03-10')).host).toBe('archive-api.open-meteo.com');
  });
});

describe('fetchLaunchWeather', () => {
  it('reads the launch hour from the forecast and lifts pressure levels above the terrain', async () => {
    const fetchFn = fakeFetch(() =>
      day({
        temperature_2m: 27, surface_pressure: 1009, precipitation_probability: 30, cloud_cover: 60,
        cloud_cover_low: 10, visibility: 15000, weather_code: 2,
        wind_speed_10m: 3.2, wind_direction_10m: 80, wind_gusts_10m: 5,
        wind_speed_80m: 4.5, wind_direction_80m: 85,
        wind_speed_850hPa: 9, wind_direction_850hPa: 120, geopotential_height_850hPa: 1508,
        // A level under the ground must be dropped.
        wind_speed_925hPa: 6, wind_direction_925hPa: 100, geopotential_height_925hPa: 100,
      }),
    );
    const w = await fetchLaunchWeather(SITE, '2026-11-25', 10, { fetchFn, today: TODAY });
    expect(w.source).toBe('forecast');
    expect(w.windSpeed).toBe(3.2);
    expect(w.temperatureC).toBe(27);
    expect(w.aloft).toEqual([
      { altitude: 80, speed: 4.5, fromDeg: 85 },
      { altitude: 1500, speed: 9, fromDeg: 120 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('averages past years for a date beyond the forecast', async () => {
    const fetchFn = fakeFetch((url) => {
      const year = Number(new URL(url).searchParams.get('start_date')?.slice(0, 4));
      return day({
        temperature_2m: 20 + (year - 2021), surface_pressure: 1012, precipitation: year === 2025 ? 1.2 : 0,
        cloud_cover: 50, wind_speed_10m: 4, wind_direction_10m: year % 2 === 0 ? 350 : 10,
        wind_gusts_10m: 6, wind_speed_100m: 7, wind_direction_100m: 0,
      });
    });
    const w = await fetchLaunchWeather(SITE, '2027-03-10', 10, { fetchFn, today: TODAY });
    expect(w.source).toBe('climatology');
    expect(w.years).toBe(5);
    expect(w.temperatureC).toBeCloseTo(22);
    expect(w.precipChance).toBeCloseTo(20);
    // 350° and 10° average to north, not south.
    expect(Math.min(w.windFromDeg, 360 - w.windFromDeg)).toBeLessThan(5);
    expect(w.aloft[0].altitude).toBe(100);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('falls back to the typical day when the forecast has no data', async () => {
    const fetchFn = fakeFetch((url) =>
      url.includes('archive-api')
        ? day({ temperature_2m: 18, wind_speed_10m: 2, wind_direction_10m: 200 })
        : day({ temperature_2m: null, wind_speed_10m: null, wind_direction_10m: null }),
    );
    const w = await fetchLaunchWeather(SITE, '2026-12-05', 10, { fetchFn, today: TODAY });
    expect(w.source).toBe('climatology');
    expect(w.windSpeed).toBeCloseTo(2);
  });

  it('rejects a malformed date and a dead network', async () => {
    await expect(fetchLaunchWeather(SITE, 'soon', 10, { today: TODAY })).rejects.toThrow();
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchLaunchWeather(SITE, '2026-11-25', 10, { fetchFn, today: TODAY })).rejects.toThrow();
  });
});

describe('averageYears', () => {
  it('keeps only the levels every year has', () => {
    const a = weather({ aloft: [{ altitude: 100, speed: 6, fromDeg: 90 }] });
    const b = weather({ aloft: [] });
    expect(averageYears([a, b], '2027-03-10', 10).aloft).toEqual([]);
  });
});

describe('assessLaunch', () => {
  it('is go in light wind and clear sky', () => {
    expect(assessLaunch(weather())).toEqual({ verdict: 'go', reasons: [] });
  });

  it('is no-go above the 20 mph safety-code wind limit', () => {
    const a = assessLaunch(weather({ windSpeed: 9.5, gustSpeed: 11 }));
    expect(a.verdict).toBe('no-go');
    expect(a.reasons[0]).toContain('8.9 m/s');
  });

  it('is no-go in a thunderstorm even when calm', () => {
    expect(assessLaunch(weather({ windSpeed: 1, gustSpeed: 2, weatherCode: 95 })).verdict).toBe('no-go');
  });

  it('is caution for strong gusts, likely rain or low cloud', () => {
    expect(assessLaunch(weather({ gustSpeed: 10 })).verdict).toBe('caution');
    expect(assessLaunch(weather({ precipChance: 50 })).verdict).toBe('caution');
    expect(assessLaunch(weather({ lowCloudCover: 80 })).verdict).toBe('caution');
    expect(assessLaunch(weather({ windSpeed: 7, gustSpeed: 8 })).verdict).toBe('caution');
  });
});

describe('describeSky', () => {
  it('uses the weather code, then falls back to cloud and rain', () => {
    expect(describeSky(weather({ weatherCode: 0 }))).toBe('Clear');
    expect(describeSky(weather({ weatherCode: 63 }))).toBe('Rain');
    expect(describeSky(weather({ weatherCode: null, cloudCover: 90 }))).toBe('Usually overcast');
    expect(describeSky(weather({ weatherCode: null, precipChance: 60 }))).toBe('Often wet');
  });
});

describe('weatherToConfig', () => {
  it('converts to the sim units', () => {
    const c = weatherToConfig(weather({ aloft: [{ altitude: 80, speed: 5, fromDeg: 180 }] }));
    expect(c.windSpeed).toBe(3);
    expect(c.windDirection).toBeCloseTo(Math.PI / 2);
    expect(c.gust).toBeCloseTo(0.5); // gusts 4.5 over a 3 m/s mean
    expect(c.groundTemperature).toBeCloseTo(298.15);
    expect(c.groundPressure).toBeCloseTo(101000);
    expect(c.windLayers).toEqual([{ altitude: 80, speed: 5, direction: Math.PI }]);
  });

  it('leaves pressure and layers unset when the source has none', () => {
    const c = weatherToConfig(weather({ pressureHpa: null, gustSpeed: null }));
    expect(c.groundPressure).toBeUndefined();
    expect(c.windLayers).toBeUndefined();
    expect(c.gust).toBe(0);
  });
});
