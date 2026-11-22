import { logger } from '../../lib/logger.js';
import { distanceKm as geoDistanceKm, type Point as GeoPoint } from './travel-geo.js';
import { findNearby } from './places-index.js';
import { TtlCache, normalizePlaceText, roundCoord } from '../maps/cache.js';
import { googleGeocode, googleNearby, googleRoute, isGoogleEnabled } from '../maps/google.js';
import { logMapsEvent } from '../maps/budget.js';

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

/**
 * Names repeat constantly across a snapshot; each one is looked up once.
 * A hit is kept 30 days (Google's limit on keeping coordinates); a miss for a
 * day, so a typo is not retried every turn but a fixed one recovers.
 */
const GEOCODE_HIT_TTL_MS = 30 * 24 * 60 * 60_000;
const GEOCODE_MISS_TTL_MS = 24 * 60 * 60_000;
const cache = new TtlCache<Point | null>(5_000, GEOCODE_HIT_TTL_MS);

export type Point = GeoPoint;

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
  /** `floor` = straight-line minimum; `route` = a real driving time. */
  basis?: 'floor' | 'route';
}

export async function geocode(place: string): Promise<Point | null> {
  const key = normalizePlaceText(place);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit !== undefined) {
    if (hit) logMapsEvent({ kind: 'cache', sku: 'geocoding', label: `כתובת: ${place.trim()}` });
    return hit;
  }

  const trimmed = place.trim();

  // Google first when it is on: it is the only one of the three that knows
  // "עזריאלי" or "Sarona Market" as a venue rather than a word. Paid once per
  // distinct name per 30 days, and the device usually sends coordinates for
  // its events anyway, so this mostly runs for names typed mid-conversation.
  if (isGoogleEnabled()) {
    const g = await googleGeocode(trimmed);
    if (g) {
      const point = { latitude: g.latitude, longitude: g.longitude };
      cache.set(key, point);
      return point;
    }
  }

  // Open-Meteo — fast, no User-Agent needed, no rate limit worries.
  // Latin-script names resolve here reliably ("Beer Sheva", "Tel Aviv",
  // "Krayon Mall") and we never pay the cost of a second lookup for them.
  const primary = await tryOpenMeteo(trimmed);
  if (primary) {
    cache.set(key, primary);
    logMapsEvent({ kind: 'free', sku: 'geocoding', label: `כתובת (Open-Meteo): ${trimmed}` });
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
      logMapsEvent({ kind: 'free', sku: 'geocoding', label: `כתובת (Nominatim): ${trimmed}` });
      return fallback;
    }
  }

  cache.set(key, null, GEOCODE_MISS_TTL_MS);
  return null;
}

/** Test seam: forget every remembered geocode and route. */
export function __clearTravelCachesForTest(): void {
  cache.clear();
  routeCache.clear();
  nearbyCache.clear();
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

/** Great-circle distance in kilometres. Re-export for existing callers. */
export const distanceKm = geoDistanceKm;

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

// ── Real driving time, paid for only when it changes the answer ─────────────

/**
 * Essentials (no traffic) answers do not depend on the clock, so a pair is
 * asked once a week. Traffic answers go stale fast: 20 minutes, with the
 * origin rounded to ~1 km so a phone drifting across the street still hits.
 */
const ROUTE_TTL_MS = 7 * 24 * 60 * 60_000;
const TRAFFIC_ROUTE_TTL_MS = 20 * 60_000;
const routeCache = new TtlCache<DrivingRoute | null>(5_000, ROUTE_TTL_MS);

export interface DrivingRoute {
  /** Door to door, parking included. */
  minutes: number;
  /** Along the road, not the straight line. */
  distanceKm: number;
}

function routeKey(from: Point, to: Point, traffic: boolean): string {
  const dp = traffic ? 2 : 3;
  return [
    traffic ? 'pro' : 'ess',
    roundCoord(from.latitude, dp),
    roundCoord(from.longitude, dp),
    roundCoord(to.latitude, 3),
    roundCoord(to.longitude, 3),
  ].join(':');
}

/** The flat "leaving the room, finding the car, parking" no route includes. */
const DOOR_TO_DOOR_MINUTES = 5;

/**
 * Minutes of driving between two points per Google, door to door, or null
 * when Google is off, out of budget, or did not answer — callers then keep
 * the straight-line floor.
 */
export async function drivingMinutes(
  from: Point,
  to: Point,
  opts: { traffic?: boolean; departAt?: Date } = {},
): Promise<number | null> {
  return (await drivingRoute(from, to, opts))?.minutes ?? null;
}

/** Same lookup and cache as `drivingMinutes`, with the road distance too. */
export async function drivingRoute(
  from: Point,
  to: Point,
  opts: { traffic?: boolean; departAt?: Date } = {},
): Promise<DrivingRoute | null> {
  if (!isGoogleEnabled()) return null;
  const traffic = opts.traffic === true;
  const key = routeKey(from, to, traffic);
  const hit = routeCache.get(key);
  if (hit !== undefined) {
    if (hit !== null) {
      logMapsEvent({
        kind: 'cache',
        sku: traffic ? 'routes_pro' : 'routes_essentials',
        label: `מסלול${traffic ? ' עם פקקים' : ''} מהזיכרון: ${hit.minutes} דק'`,
      });
    }
    return hit;
  }
  const route = await googleRoute(from, to, { traffic, departAt: opts.departAt });
  // A failure is remembered briefly so one bad pair cannot burn a request on
  // every candidate the scheduler tries.
  if (!route) {
    routeCache.set(key, null, 5 * 60_000);
    return null;
  }
  const result: DrivingRoute = {
    minutes: route.minutes + DOOR_TO_DOOR_MINUTES,
    distanceKm: route.distanceKm,
  };
  routeCache.set(key, result, traffic ? TRAFFIC_ROUTE_TTL_MS : ROUTE_TTL_MS);
  return result;
}

export type LegGate = 'impossible' | 'fits' | 'tight';

/**
 * Whether the straight-line floor already settles a journey.
 *
 * The floor is optimistic by construction, so a floor that does not fit is
 * certainly impossible, and a gap of at least twice the floor plus a quarter
 * of an hour is, in practice, always enough. Only the band in between needs a
 * real route — and that band is the only place Google is asked.
 */
export function gateLeg(floorMinutes: number, availableMinutes: number): LegGate {
  if (floorMinutes > availableMinutes) return 'impossible';
  if (availableMinutes >= floorMinutes * 2 + 15) return 'fits';
  return 'tight';
}

interface Stop {
  title: string;
  place: string;
  /** Coordinates the device already resolved, when it sent them. */
  point: Point | null;
  startsAt: number;
  endsAt: number;
}

/** An event as travel checks see it. Coordinates are optional and preferred. */
export interface TravelEvent {
  title: string;
  location?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  startsAt: string;
  endsAt?: string | null;
}

/** The event's own coordinates, when the device sent valid ones. */
export function eventPoint(e: {
  locationLat?: number | null;
  locationLng?: number | null;
}): Point | null {
  const lat = e.locationLat;
  const lng = e.locationLng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

/**
 * The first pair of consecutive meetings that cannot be made in time.
 *
 * Only pairs where both carry a place are considered — an event with no
 * location says nothing about where anyone has to be, and guessing would
 * produce warnings about journeys nobody is making.
 */
export async function findImpossibleLeg(
  events: TravelEvent[],
  /** Injected so the rules can be tested without a network between them. */
  resolve: (place: string) => Promise<Point | null> = geocode,
  /** Injected likewise. Defaults to Google's driving time (null when off). */
  drive: (from: Point, to: Point) => Promise<number | null> = (a, b) => drivingMinutes(a, b),
): Promise<TravelLeg | null> {
  const stops: Stop[] = [];
  for (const e of events) {
    const place = e.location?.trim();
    if (!place) continue;
    const startsAt = new Date(e.startsAt).getTime();
    if (Number.isNaN(startsAt)) continue;
    const rawEnd = e.endsAt ? new Date(e.endsAt).getTime() : NaN;
    const endsAt = Number.isNaN(rawEnd) || rawEnd <= startsAt ? startsAt + 60 * 60_000 : rawEnd;
    stops.push({ title: e.title, place, point: eventPoint(e), startsAt, endsAt });
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

    const [a, b] = await Promise.all([
      from.point ?? resolve(from.place),
      to.point ?? resolve(to.place),
    ]);
    if (!a || !b) continue; // an unknown name is not evidence of anything

    const km = distanceKm(a, b);
    const floor = travelMinutes(km);
    const gate = gateLeg(floor, availableMinutes);
    // A route Google would have been asked for, had the floor not settled it.
    if (gate !== 'tight' && isGoogleEnabled()) {
      logMapsEvent({
        kind: 'gate',
        sku: 'routes_essentials',
        label:
          gate === 'fits'
            ? `${from.place} → ${to.place}: ${availableMinutes} דק' פנויות, מספיק בבירור`
            : `${from.place} → ${to.place}: ${availableMinutes} דק' פנויות, בלתי אפשרי גם בקו אוויר`,
      });
    }
    if (gate === 'fits') continue;

    let neededMinutes = floor;
    let basis: 'floor' | 'route' = 'floor';
    if (gate === 'tight') {
      const real = await drive(a, b);
      // No real answer means the floor stands, and a floor that fits is not a
      // warning — exactly the behaviour before Google was wired in.
      if (real === null || real <= availableMinutes) continue;
      neededMinutes = real;
      basis = 'route';
    }

    return {
      fromTitle: from.title,
      fromPlace: from.place,
      toTitle: to.title,
      toPlace: to.place,
      availableMinutes,
      neededMinutes,
      distanceKm: Math.round(km),
      basis,
    };
  }

  return null;
}

// ── Nearby places via the local OSM snapshot ────────────────────────────────
//
// We used to ask the public Overpass API at voice-turn time. In practice the
// endpoint is at capacity more often than not — ~90% of lookups came back as
// HTTP 502 or a connect timeout, so the agent "could not find any malls"
// most of the time even though the data existed. The fix was to lift the
// network out of the hot path entirely: a one-shot script dumps every shop,
// pharmacy, café and restaurant in Israel into `backend/data/places-il.json`
// at build time, and runtime does a plain haversine over that array.
//
// See `scripts/dump-il-places.ts` to refresh the snapshot, and
// `places-index.ts` for the lookup itself.

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
  try {
    return findNearby(center, category, radiusMeters, limit);
  } catch (err) {
    logger.warn({ err: String(err), category }, 'nearby search failed');
    return [];
  }
}

// ── Nearby, with Google as the exception rather than the rule ───────────────

export interface NearbyResult {
  places: (NearbyPlace & { openNow?: boolean })[];
  /** Where the answer came from — `osm` costs nothing. */
  source: 'osm' | 'google' | 'osm+google';
  /** True when "open now" was asked for and could actually be checked. */
  openNowChecked: boolean;
}

/** Below this many local hits, the snapshot is treated as having nothing. */
const MIN_LOCAL_HITS = 2;
/** Google nearby answers are kept an hour (by ~1 km cell and category). */
const NEARBY_TTL_MS = 60 * 60_000;
const nearbyCache = new TtlCache<NearbyResult>(2_000, NEARBY_TTL_MS);

/**
 * The agent's nearby lookup.
 *
 * The OSM snapshot answers first and alone whenever it has something — free,
 * instant, no network. Google is asked only when (a) the snapshot has fewer
 * than two places for this category here, or (b) the user asked what is open
 * right now, which only Google knows (and which is the pricier Enterprise
 * request, so it is never sent unasked).
 */
export async function findNearbySmart(
  center: Point,
  category: string,
  opts: { radiusMeters?: number; limit?: number; openNow?: boolean } = {},
): Promise<NearbyResult> {
  const radiusMeters = opts.radiusMeters ?? 3000;
  const limit = opts.limit ?? 8;
  const openNow = opts.openNow === true;

  const local = await searchNearby(center, category, radiusMeters, limit);
  const needGoogle = openNow || local.length < MIN_LOCAL_HITS;
  if (!needGoogle || !isGoogleEnabled()) {
    if (isGoogleEnabled()) {
      logMapsEvent({
        kind: 'free',
        sku: 'nearby_pro',
        label: `מקומות מהקובץ המקומי: ${category} (${local.length} תוצאות)`,
      });
    }
    return { places: local, source: 'osm', openNowChecked: false };
  }

  const key = [
    openNow ? 'open' : 'any',
    category,
    roundCoord(center.latitude, 2),
    roundCoord(center.longitude, 2),
    Math.round(radiusMeters / 500),
  ].join(':');
  const hit = nearbyCache.get(key);
  if (hit) {
    logMapsEvent({
      kind: 'cache',
      sku: openNow ? 'nearby_enterprise' : 'nearby_pro',
      label: `מקומות מהזיכרון: ${category}`,
    });
    return withDistances(hit, center, limit);
  }

  const remote = await googleNearby(center, category, {
    radiusMeters,
    limit,
    withOpenNow: openNow,
  });
  if (!remote) return { places: local, source: 'osm', openNowChecked: false };

  const fromGoogle = remote
    .filter((p) => !openNow || p.openNow !== false)
    .map((p) => ({
      name: p.name,
      category,
      latitude: p.latitude,
      longitude: p.longitude,
      distanceKm: 0,
      ...(p.openNow !== undefined ? { openNow: p.openNow } : {}),
    }));

  // "Open now" answers stand on Google alone: an OSM place with unknown hours
  // mixed into an "open now" list would be a guess presented as a fact.
  const merged = openNow ? fromGoogle : mergeByName(local, fromGoogle);
  const result: NearbyResult = {
    places: merged,
    source: openNow ? 'google' : local.length > 0 ? 'osm+google' : 'google',
    openNowChecked: openNow,
  };
  nearbyCache.set(key, result);
  return withDistances(result, center, limit);
}

function mergeByName<T extends { name: string }>(a: T[], b: T[]): T[] {
  const seen = new Set(a.map((p) => p.name.trim().toLowerCase()));
  return [...a, ...b.filter((p) => !seen.has(p.name.trim().toLowerCase()))];
}

/** Distances are recomputed from the asking point, since the cache is per cell. */
function withDistances(r: NearbyResult, center: Point, limit: number): NearbyResult {
  const places = r.places
    .map((p) => ({
      ...p,
      distanceKm: Math.round(distanceKm(center, p) * 10) / 10,
    }))
    .sort((x, y) => x.distanceKm - y.distanceKm)
    .slice(0, limit);
  return { ...r, places };
}
