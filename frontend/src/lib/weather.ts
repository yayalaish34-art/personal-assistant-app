import AsyncStorage from '@react-native-async-storage/async-storage';

// Today's weather, for the line under the greeting.
//
// Best-effort throughout: this is context, not content. Every failure — no
// network, an unknown place, a provider that changed its mind — resolves to
// null and the screen simply shows the date without it. Nothing here is ever
// allowed to throw into a render.
//
// No location permission is asked for. An IANA timezone is already a city
// name — `Asia/Jerusalem`, `Europe/Madrid` — which is accurate enough for "is
// it raining", and costs the user no prompt. Somebody travelling with their
// phone on home time gets home's weather; that is the trade.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const PLACE_KEY = '@pa/weatherPlace';
const READING_KEY = '@pa/weatherReading';

/** Weather is worth re-asking for about twice an hour. */
const READING_TTL_MS = 30 * 60 * 1000;
/** Where the phone is does not change often enough to re-resolve. */
const PLACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The families the WMO codes collapse into — one per icon. */
export type Sky = 'clear' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export interface Weather {
  /** Whole degrees Celsius. */
  temperature: number;
  sky: Sky;
  /** The provider's own daylight flag, which knows the season. */
  isDay: boolean;
}

type Place = { at: number; latitude: number; longitude: number };
type Reading = { at: number; value: Weather };

/** https://open-meteo.com/en/docs — WMO 4677, grouped to what an icon can say. */
function skyOf(code: number): Sky {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}

async function readCache<T extends { at: number }>(key: string, ttl: number): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    if (typeof parsed?.at !== 'number' || Date.now() - parsed.at > ttl) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The city half of the timezone: `Asia/Jerusalem` → `Jerusalem`.
 *
 * Only zones that actually name a place qualify. A device reporting `UTC`,
 * `GMT` or an `Etc/…` offset has told us nothing about where it is, and
 * sending those to a geocoder returns whatever happens to match the letters.
 */
function cityFromTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || !tz.includes('/') || tz.startsWith('Etc/')) return null;
    const city = tz.split('/').pop()?.replace(/_/g, ' ');
    return city && city.length > 1 ? city : null;
  } catch {
    return null;
  }
}

async function resolvePlace(): Promise<Place | null> {
  const cached = await readCache<Place>(PLACE_KEY, PLACE_TTL_MS);
  if (cached) return cached;

  const city = cityFromTimezone();
  if (!city) return null;

  try {
    const res = await fetch(
      `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1&format=json`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results?: { latitude: number; longitude: number }[];
    };
    const hit = body.results?.[0];
    if (!hit) return null;

    const place: Place = { at: Date.now(), latitude: hit.latitude, longitude: hit.longitude };
    await AsyncStorage.setItem(PLACE_KEY, JSON.stringify(place)).catch(() => undefined);
    return place;
  } catch {
    return null;
  }
}

/**
 * The current conditions, or null if they cannot be had.
 *
 * A stale reading is served while a fresh one is fetched only in the sense
 * that the cache is checked first — there is no background refresh, because
 * the screen asks again every time it comes into focus anyway.
 */
export async function getWeather(): Promise<Weather | null> {
  const cached = await readCache<Reading>(READING_KEY, READING_TTL_MS);
  if (cached) return cached.value;

  const place = await resolvePlace();
  if (!place) return null;

  try {
    const res = await fetch(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,weather_code,is_day&timezone=auto`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number; is_day?: number };
    };
    const current = body.current;
    if (typeof current?.temperature_2m !== 'number') return null;

    const value: Weather = {
      temperature: Math.round(current.temperature_2m),
      sky: skyOf(current.weather_code ?? 3),
      isDay: current.is_day === 1,
    };
    await AsyncStorage.setItem(
      READING_KEY,
      JSON.stringify({ at: Date.now(), value } satisfies Reading),
    ).catch(() => undefined);
    return value;
  } catch {
    return null;
  }
}

/**
 * Day or night without asking anyone.
 *
 * Used before the first reading arrives, and instead of one if it never does,
 * so the sun or moon is on screen immediately rather than appearing a second
 * later. Crude on purpose — the provider's flag replaces it as soon as it
 * lands.
 */
export function isDaylightNow(): boolean {
  const h = new Date().getHours();
  return h >= 6 && h < 19;
}
