import * as Location from 'expo-location';

// Places, driving times and navigation, as cheaply as they can be had.
//
// The order is always the same: what the phone already knows (free), then
// what the phone can work out by itself (free — the OS geocoder), and only
// then the server's /maps routes, which may spend a Google request. The server
// keeps the key and the daily budget; nothing here holds a key.
//
// Deliberately imports nothing from ./api, so api.ts can call in here without
// a require cycle.

export const API_BASE = (
  process.env.EXPO_PUBLIC_API_URL || 'https://personal-assistant-api-production-618a.up.railway.app'
).replace(/\/$/, '');

export interface PlacePoint {
  latitude: number;
  longitude: number;
  /** Google's id when the server resolved it; null from the OS geocoder. */
  placeId: string | null;
}

const TIMEOUT_MS = 6_000;

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const resolved = new Map<string, PlacePoint | null>();

/**
 * Text → coordinates, for saving on an event once.
 *
 * The phone's own geocoder first (Apple's on iOS, Google's on Android — free
 * to the app either way); the server only when it found nothing.
 */
export async function resolvePlacePoint(text: string, language = 'he'): Promise<PlacePoint | null> {
  const key = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (resolved.has(key)) return resolved.get(key) ?? null;

  let point: PlacePoint | null = null;
  try {
    const [first] = await Location.geocodeAsync(text.trim());
    if (first && Number.isFinite(first.latitude) && Number.isFinite(first.longitude)) {
      point = { latitude: first.latitude, longitude: first.longitude, placeId: null };
    }
  } catch {
    /* no permission or no result — try the server */
  }

  if (!point) {
    const res = await postJson<{
      place: { latitude: number; longitude: number; placeId: string | null } | null;
    }>('/maps/resolve', { text: text.trim(), language });
    if (res?.place) {
      point = {
        latitude: res.place.latitude,
        longitude: res.place.longitude,
        placeId: res.place.placeId ?? null,
      };
    }
  }

  resolved.set(key, point);
  return point;
}

/** Driving time with live traffic, from the server. Null when unreachable. */
export async function fetchEta(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  arriveBy?: string,
): Promise<{ minutes: number; withTraffic: boolean } | null> {
  const res = await postJson<{ minutes: number; withTraffic: boolean }>('/maps/eta', {
    from: { latitude: from.latitude, longitude: from.longitude },
    to: { latitude: to.latitude, longitude: to.longitude },
    ...(arriveBy ? { arriveBy } : {}),
  });
  if (!res || !Number.isFinite(res.minutes)) return null;
  return res;
}

export interface ErrandFence {
  id: string;
  taskId: string;
  taskTitle: string;
  placeName: string;
  category: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

/** Shops worth a geofence for the open errand tasks. Free on the server (OSM). */
export async function fetchErrandFences(
  near: { latitude: number; longitude: number },
  tasks: { id: string; title: string }[],
  max: number,
): Promise<ErrandFence[] | null> {
  if (tasks.length === 0 || max <= 0) return [];
  const res = await postJson<{ fences: ErrandFence[] }>('/maps/errand-fences', {
    near: { latitude: near.latitude, longitude: near.longitude },
    tasks: tasks.slice(0, 100).map((t) => ({ id: t.id, title: t.title.slice(0, 300) })),
    max: Math.min(15, Math.max(1, Math.floor(max))),
  });
  return res?.fences ?? null;
}

/**
 * Turn-by-turn links. Free: these open the user's own app, no key, no
 * request billed to anyone.
 */
export function navigationUrls(event: {
  location?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  locationPlaceId?: string | null;
}): { google: string; waze: string } | null {
  const hasPoint =
    typeof event.locationLat === 'number' && typeof event.locationLng === 'number';
  const text = event.location?.trim();
  if (!hasPoint && !text) return null;

  const dest = hasPoint ? `${event.locationLat},${event.locationLng}` : text!;
  const google =
    'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
    `&destination=${encodeURIComponent(dest)}` +
    (event.locationPlaceId ? `&destination_place_id=${encodeURIComponent(event.locationPlaceId)}` : '');
  const waze = hasPoint
    ? `https://waze.com/ul?ll=${event.locationLat},${event.locationLng}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(text!)}&navigate=yes`;
  return { google, waze };
}
