import * as Location from 'expo-location';

import { getLocation } from './location';

// Device-side travel estimate for events with a `location` field.
//
// The backend has a careful version of this (voice/travel.ts, Open-Meteo +
// Nominatim) but it is only reachable through the voice turn and would need
// a round-trip for every event write — not worth it for scheduling a single
// reminder. This version is deliberately simple: it uses expo-location's
// forward geocoder, the user's cached foreground position, and a flat
// average speed. It is only used to decide *when* to buzz "time to head
// out" — being a few minutes off is survivable, and the fallbacks all keep
// a user from missing a meeting rather than tempting them to be late.
//
// The function returns null when it cannot give an honest answer (no
// permission, no cached fix, geocoding failed, place has no coordinates):
// the caller falls back to the ordinary prep reminder.

const EARTH_RADIUS_KM = 6371;

/** Mixed urban-and-highway average. Deliberately conservative — a reminder
 * that errs on "leave now" is better than one that errs on "stay seated". */
const AVERAGE_KMH = 45;

/** A parking spot, a lift, a walk from the car — the time no map ever shows. */
const PARKING_BUFFER_MIN = 5;

/** Cache geocoded strings for the lifetime of the process. The same event
 * title gets rescheduled many times (edits, reminder change, snoozes) and
 * forward-geocoding is not free. */
const geocodeCache = new Map<string, { latitude: number; longitude: number } | null>();

function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function geocode(place: string): Promise<{ latitude: number; longitude: number } | null> {
  const key = place.trim().toLowerCase();
  if (!key) return null;
  const hit = geocodeCache.get(key);
  if (hit !== undefined) return hit;

  try {
    const results = await Location.geocodeAsync(place.trim());
    const first = results[0];
    if (first && Number.isFinite(first.latitude) && Number.isFinite(first.longitude)) {
      const point = { latitude: first.latitude, longitude: first.longitude };
      geocodeCache.set(key, point);
      return point;
    }
  } catch {
    /* fall through to the null-cache below */
  }
  geocodeCache.set(key, null);
  return null;
}

/**
 * Minutes to leave by, from the user's last known location to the given
 * place, or null when there is nothing reliable to say. The returned number
 * already includes a small parking buffer, so the caller can schedule the
 * reminder at `startsAt - estimateMinutes` without adding its own padding.
 */
export async function estimateTravelMinutes(place: string | null | undefined): Promise<number | null> {
  if (!place || !place.trim()) return null;

  const here = getLocation();
  if (!here) return null;

  const there = await geocode(place);
  if (!there) return null;

  const km = haversineKm(here, there);
  // Nothing to say about a place "across the street"; the regular prep
  // reminder covers it.
  if (km < 1) return null;

  const driveMin = (km / AVERAGE_KMH) * 60;
  return Math.max(5, Math.round(driveMin + PARKING_BUFFER_MIN));
}
