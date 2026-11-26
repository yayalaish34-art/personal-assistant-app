import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { getLocation } from './location';

// Today's weather, for the line under the greeting.
//
// Best-effort throughout: this is context, not content. Every failure — no
// network, an unknown place, a provider that changed its mind — resolves to
// null and the screen simply shows the date without it. Nothing here is ever
// allowed to throw into a render.
//
// Where: the phone's own position when location was already granted (the
// assistant asks for it), the same place the assistant's weather is for.
// Never a prompt from here. Without it, the city in the timezone — but that
// is only a guess: every phone in Israel says `Asia/Jerusalem`, and Jerusalem
// sits 800 m up, often several degrees colder and wetter than the coast.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Versioned: the cached shape gained a place name and a high/low, and an old
// entry would deserialise into a reading with those fields missing.
const PLACE_KEY = '@pa/weatherPlace2';
// Bumped with the shape: a reading cached before the week existed would
// deserialise with `days` missing and the strip would render empty for half an
// hour after an update. 5: readings now remember where they are for, so a
// Jerusalem one from before is not served to a phone in Tel Aviv.
const READING_KEY = '@pa/weatherReading5';

/** A reading further than this from where the phone is now is someone else's weather. */
const SAME_PLACE_KM = 5;
/** A last-known fix older than this says little about where the phone is. */
const LAST_FIX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** How much of the week ahead the strip shows. */
const FORECAST_DAYS = 7;

/** How many hours ahead the hourly strip shows (24 h from now). */
const FORECAST_HOURS = 24;

/** Weather is worth re-asking for about twice an hour. */
const READING_TTL_MS = 30 * 60 * 1000;
/** Where the phone is does not change often enough to re-resolve. */
const PLACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The families the WMO codes collapse into — one per icon. */
export type Sky = 'clear' | 'partly' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export interface Weather {
  /** Whole degrees Celsius. */
  temperature: number;
  /** What it feels like, which is often the more useful number. */
  feelsLike: number;
  sky: Sky;
  /** The provider's own daylight flag, which knows the season. */
  isDay: boolean;
  /** Today's range, for the line under the temperature. */
  high: number;
  low: number;
  /** Where this reading is for — the city, as the geocoder named it. */
  place: string | null;
  /** The week ahead, today first. Empty if the provider gave nothing usable. */
  days: DayForecast[];
  /** The next 24 hours, starting from the current hour. */
  hours: HourForecast[];
}

/** One day of the strip under the greeting. */
export interface DayForecast {
  /** `YYYY-MM-DD`, as the provider dated it in the place's own timezone. */
  date: string;
  high: number;
  low: number;
  sky: Sky;
}

/** One hour in the hourly forecast strip. */
export interface HourForecast {
  /** ISO datetime string from the provider, e.g. `2026-09-29T14:00`. */
  time: string;
  temperature: number;
  sky: Sky;
  isDay: boolean;
}

type Place = { at: number; latitude: number; longitude: number; name: string | null };
type Reading = { at: number; latitude: number; longitude: number; value: Weather };

/** Straight-line distance, km. Plenty for "is this the same town". */
function kmBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Today as the phone's clock reads it — not UTC, which is yesterday until 02:00 in Israel. */
function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

/**
 * Where the phone actually is, if location was already granted.
 *
 * The tracker's live fix first (running whenever the app has the permission),
 * then the system's last known one — instant, and it never shows a prompt.
 */
async function phonePlace(): Promise<Place | null> {
  try {
    let fix = getLocation();
    if (!fix) {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted') return null;
      const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_FIX_MAX_AGE_MS });
      if (!last) return null;
      fix = { latitude: last.coords.latitude, longitude: last.coords.longitude };
    }
    let name = fix.city ?? null;
    if (!name) {
      try {
        const [hit] = await Location.reverseGeocodeAsync({ latitude: fix.latitude, longitude: fix.longitude });
        name = hit?.city ?? hit?.subregion ?? null;
      } catch {
        /* the weather is still right without the name */
      }
    }
    return { at: Date.now(), latitude: fix.latitude, longitude: fix.longitude, name };
  } catch {
    return null;
  }
}

async function resolvePlace(): Promise<Place | null> {
  const here = await phonePlace();
  if (here) return here;

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
      results?: { latitude: number; longitude: number; name?: string }[];
    };
    const hit = body.results?.[0];
    if (!hit) return null;

    const place: Place = {
      at: Date.now(),
      latitude: hit.latitude,
      longitude: hit.longitude,
      // The geocoder's own spelling, which is better than the timezone's
      // underscore-separated one and is what the screen shows.
      name: hit.name ?? null,
    };
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
  const place = await resolvePlace();
  if (!place) return null;

  // Fresh and for this same place, or asked for again.
  const cached = await readCache<Reading>(READING_KEY, READING_TTL_MS);
  if (cached && kmBetween(cached, place) <= SAME_PLACE_KM) return cached.value;

  try {
    const res = await fetch(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,apparent_temperature,weather_code,is_day` +
        `&hourly=temperature_2m,weather_code,is_day` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
        `&forecast_days=${FORECAST_DAYS}&timezone=auto`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        is_day?: number;
      };
      hourly?: {
        time?: string[];
        temperature_2m?: number[];
        weather_code?: number[];
        is_day?: number[];
      };
      daily?: {
        time?: string[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        weather_code?: number[];
      };
    };
    const current = body.current;
    if (typeof current?.temperature_2m !== 'number') return null;

    const now = Math.round(current.temperature_2m);
    // The daily arrays are one entry long here, and either can be absent if the
    // provider trims the response; falling back to the current reading keeps
    // the line sensible rather than printing an empty range.
    const high = body.daily?.temperature_2m_max?.[0];
    const low = body.daily?.temperature_2m_min?.[0];

    // The week, as far as the provider filled it in. Any day missing a
    // temperature is dropped rather than guessed at — a strip with a gap is
    // honest, a strip with a made-up number is not.
    const d = body.daily;
    const days: DayForecast[] = (d?.time ?? []).flatMap((date, i) => {
      const hi = d?.temperature_2m_max?.[i];
      const lo = d?.temperature_2m_min?.[i];
      if (typeof hi !== 'number' || typeof lo !== 'number') return [];
      return [{ date, high: Math.round(hi), low: Math.round(lo), sky: skyOf(d?.weather_code?.[i] ?? 3) }];
    });

    const h = body.hourly;
    const nowHour = new Date().getHours();
    const todayDate = localDate();
    const hours: HourForecast[] = [];
    if (h?.time) {
      const startIdx = h.time.findIndex((t) => {
        const tDate = t.slice(0, 10);
        const tHour = parseInt(t.slice(11, 13), 10);
        return tDate === todayDate && tHour >= nowHour;
      });
      if (startIdx >= 0) {
        for (let i = startIdx; i < Math.min(startIdx + FORECAST_HOURS, h.time.length); i++) {
          const temp = h.temperature_2m?.[i];
          if (typeof temp !== 'number') continue;
          hours.push({
            time: h.time[i],
            temperature: Math.round(temp),
            sky: skyOf(h.weather_code?.[i] ?? 3),
            isDay: h.is_day?.[i] === 1,
          });
        }
      }
    }

    const value: Weather = {
      temperature: now,
      feelsLike: Math.round(current.apparent_temperature ?? current.temperature_2m),
      sky: skyOf(current.weather_code ?? 3),
      isDay: current.is_day === 1,
      high: typeof high === 'number' ? Math.round(high) : now,
      low: typeof low === 'number' ? Math.round(low) : now,
      place: place.name,
      days,
      hours,
    };
    await AsyncStorage.setItem(
      READING_KEY,
      JSON.stringify({
        at: Date.now(),
        latitude: place.latitude,
        longitude: place.longitude,
        value,
      } satisfies Reading),
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
