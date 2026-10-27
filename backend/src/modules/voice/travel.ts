import { logger } from '../../lib/logger.js';

/**
 * Can someone actually get from one meeting to the next?
 *
 * A meeting in Jerusalem and another in Haifa half an hour later does not
 * clash on the clock — the hours are free — and every overlap check in the
 * world says it is fine. It is still impossible.
 *
 * The estimate here is deliberately crude, and crude in one direction only.
 * Distance is measured great-circle, which is the shortest line that exists
 * between two points: no road is ever shorter. So when even that line does not
 * fit in the gap, the real journey certainly does not, and the warning is
 * sound. The reverse does not hold, and this file does not pretend it does —
 * a trip that fits on paper may still be hopeless in traffic, and nothing is
 * said about those.
 *
 * Places are resolved with the same free geocoder the weather uses: no key, no
 * account, and no location permission asked of anyone.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
/**
 * Fallback for names the first geocoder cannot find.
 *
 * Open-Meteo indexes mostly Latin-script names, so "Beer Sheva" works but
 * "באר שבע" returns nothing. Nominatim indexes OSM, which carries every name
 * in every language a mapper added, so Hebrew, Arabic and Persian names
 * resolve too. The User-Agent is mandatory and must identify the app;
 * Nominatim bans anonymous traffic.
 */
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_UA = 'PlanziAssistant/1.0 (support@planzi.app)';

/** How long a lookup may hold up the turn it is running inside. */
const GEOCODE_TIMEOUT_MS = 2_000;
/** Per-attempt budget when both geocoders are tried in sequence. */
const PER_ATTEMPT_TIMEOUT_MS = 1_500;

/** Names repeat constantly across a snapshot; each one is looked up once. */
const cache = new Map<string, Point | null>();

export interface Point {
  latitude: number;
  longitude: number;
}

export interface TravelLeg {
  fromTitle: string;
  fromPlace: string;
  toTitle: string;
  toPlace: string;
  /** Minutes actually available between the two. */
  availableMinutes: number;
  /** Minutes the journey needs at the very least. */
  neededMinutes: number;
  distanceKm: number;
}

export async function geocode(place: string): Promise<Point | null> {
  const key = place.trim().toLowerCase();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const trimmed = place.trim();

  // Open-Meteo first — fast, no User-Agent needed, no rate limit worries.
  // Latin-script names resolve here reliably ("Beer Sheva", "Tel Aviv",
  // "Krayon Mall") and we never pay the cost of a second lookup for them.
  const primary = await tryOpenMeteo(trimmed);
  if (primary) {
    cache.set(key, primary);
    return primary;
  }

  // Nothing on Open-Meteo. If the name carries non-Latin characters —
  // Hebrew, Arabic, Persian — the next try is Nominatim, which indexes OSM
  // and holds those names at the source. Latin-only misses stop here: a
  // misspelled "Blerzsheba" is not a Nominatim case.
  if (hasNonLatin(trimmed)) {
    const fallback = await tryNominatim(trimmed);
    if (fallback) {
      cache.set(key, fallback);
      return fallback;
    }
  }

  cache.set(key, null);
  return null;
}

/**
 * Does the string carry any character outside basic Latin? If yes, a lookup
 * against a Latin-first geocoder is likely to miss and the Nominatim fallback
 * is worth trying.
 */
function hasNonLatin(s: string): boolean {
  // Hebrew: ֐–׿. Arabic: ؀–ۿ. Persian/Urdu extension:
  // ܀–ݿ. CJK and others we leave for later — the current app
  // targets Hebrew first.
  return /[֐-׿؀-ۿ܀-ݿ]/.test(s);
}

async function tryOpenMeteo(name: string): Promise<Point | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&format=json`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results?: { latitude: number; longitude: number }[];
    };
    const first = body.results?.[0];
    return first ? { latitude: first.latitude, longitude: first.longitude } : null;
  } catch (err) {
    logger.warn({ err: String(err), place: name }, 'open-meteo geocode failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tryNominatim(name: string): Promise<Point | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${NOMINATIM_URL}?q=${encodeURIComponent(name)}&format=json&limit=1`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'he,en' },
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ lat: string; lon: string }>;
    const first = body[0];
    if (!first) return null;
    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch (err) {
    logger.warn({ err: String(err), place: name }, 'nominatim geocode failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The least time the journey could take, in minutes.
 *
 * Speeds rise with distance because that is how journeys actually work — a
 * couple of kilometres across a city is slower per kilometre than a hundred on
 * a motorway. Every figure is optimistic on purpose; this is a floor, not an
 * estimate. The flat few minutes on top is leaving the room and finding the
 * car, which no distance accounts for and which is never zero.
 */
export function travelMinutes(km: number): number {
  if (km < 0.3) return 0; // the same building, near enough
  const kmh = km < 2 ? 12 : km < 15 ? 30 : km < 60 ? 60 : 85;
  return Math.round((km / kmh) * 60) + 8;
}

interface Stop {
  title: string;
  place: string;
  startsAt: number;
  endsAt: number;
}

/**
 * The first pair of consecutive meetings that cannot be made in time.
 *
 * Only pairs where both carry a place are considered — an event with no
 * location says nothing about where anyone has to be, and guessing would
 * produce warnings about journeys nobody is making.
 */
export async function findImpossibleLeg(
  events: { title: string; location?: string | null; startsAt: string; endsAt?: string | null }[],
  /** Injected so the rules can be tested without a network between them. */
  resolve: (place: string) => Promise<Point | null> = geocode,
): Promise<TravelLeg | null> {
  const stops: Stop[] = [];
  for (const e of events) {
    const place = e.location?.trim();
    if (!place) continue;
    const startsAt = new Date(e.startsAt).getTime();
    if (Number.isNaN(startsAt)) continue;
    const rawEnd = e.endsAt ? new Date(e.endsAt).getTime() : NaN;
    const endsAt = Number.isNaN(rawEnd) || rawEnd <= startsAt ? startsAt + 60 * 60_000 : rawEnd;
    stops.push({ title: e.title, place, startsAt, endsAt });
  }

  if (stops.length < 2) return null;
  stops.sort((a, b) => a.startsAt - b.startsAt);

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i]!;
    const to = stops[i + 1]!;
    if (from.place.trim().toLowerCase() === to.place.trim().toLowerCase()) continue;

    const availableMinutes = Math.round((to.startsAt - from.endsAt) / 60_000);
    // Already overlapping in time — that is the clash check's business, not
    // this one's, and reporting it here would say the wrong thing about why.
    if (availableMinutes < 0) continue;

    const [a, b] = await Promise.all([resolve(from.place), resolve(to.place)]);
    if (!a || !b) continue; // an unknown name is not evidence of anything

    const km = distanceKm(a, b);
    const neededMinutes = travelMinutes(km);
    if (neededMinutes <= availableMinutes) continue;

    return {
      fromTitle: from.title,
      fromPlace: from.place,
      toTitle: to.title,
      toPlace: to.place,
      availableMinutes,
      neededMinutes,
      distanceKm: Math.round(km),
    };
  }

  return null;
}

// ── Nearby places via OpenStreetMap Overpass ────────────────────────────────

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 6_000;

const CATEGORY_TAGS: Record<string, string[]> = {
  shopping:     ['"shop"="mall"', '"shop"="department_store"', '"shop"="supermarket"'],
  supermarket:  ['"shop"="supermarket"'],
  mall:         ['"shop"="mall"', '"shop"="department_store"'],
  restaurant:   ['"amenity"="restaurant"'],
  cafe:         ['"amenity"="cafe"'],
  pharmacy:     ['"amenity"="pharmacy"'],
  gas_station:  ['"amenity"="fuel"'],
  gym:          ['"leisure"="fitness_centre"'],
  park:         ['"leisure"="park"'],
  hospital:     ['"amenity"="hospital"'],
  bank:         ['"amenity"="bank"'],
  hotel:        ['"tourism"="hotel"'],
};

export interface NearbyPlace {
  name: string;
  category: string;
  distanceKm: number;
  latitude: number;
  longitude: number;
}

export async function searchNearby(
  center: Point,
  category: string,
  radiusMeters = 3000,
  limit = 8,
): Promise<NearbyPlace[]> {
  const tags = CATEGORY_TAGS[category];
  if (!tags) return [];

  const unions = tags
    .flatMap((tag) => [
      `node[${tag}](around:${radiusMeters},${center.latitude},${center.longitude});`,
      `way[${tag}](around:${radiusMeters},${center.latitude},${center.longitude});`,
    ])
    .join('\n');

  const query = `[out:json][timeout:5];(\n${unions}\n);out center ${limit * 2};`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) return [];

    const body = (await res.json()) as {
      elements?: Array<{
        tags?: Record<string, string>;
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
      }>;
    };

    const seen = new Set<string>();
    const results: NearbyPlace[] = [];

    for (const el of body.elements ?? []) {
      const name = el.tags?.name;
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;

      results.push({
        name,
        category,
        distanceKm: Math.round(distanceKm(center, { latitude: lat, longitude: lon }) * 10) / 10,
        latitude: lat,
        longitude: lon,
      });
    }

    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.slice(0, limit);
  } catch (err) {
    logger.warn({ err, category }, 'nearby search failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}
