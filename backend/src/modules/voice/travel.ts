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

/** How long a lookup may hold up the turn it is running inside. */
const GEOCODE_TIMEOUT_MS = 2_000;

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

  // Bounded, because this runs inside a voice turn with someone waiting at the
  // end of it. A bare fetch has no timeout at all: one unresponsive geocoder
  // would hold the turn open until the socket gave up on its own, and the
  // conversation would simply stop with no error to show for it. Two seconds
  // is generous for a lookup whose only job is to answer "can they get there",
  // and the answer to a lookup that misses is the same as one that fails —
  // say nothing about that leg.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${GEOCODE_URL}?name=${encodeURIComponent(place.trim())}&count=1&format=json`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }
    const body = (await res.json()) as {
      results?: { latitude: number; longitude: number }[];
    };
    const first = body.results?.[0];
    const point = first ? { latitude: first.latitude, longitude: first.longitude } : null;
    cache.set(key, point);
    return point;
  } catch (err) {
    logger.warn({ err, place }, 'geocode failed');
    // Not cached: a network blip should not poison the name for the process.
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
