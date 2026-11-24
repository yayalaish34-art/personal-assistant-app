import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { logMapsEvent, tryCharge, type MapsSku } from './budget.js';

/**
 * The only file that talks to Google Maps Platform.
 *
 * Three rules hold every function here:
 *   1. Ask the budget first. No reservation, no request.
 *   2. Ask for the fewest fields. Google bills a request at the price of the
 *      most expensive field in its mask, so one stray field can triple it.
 *   3. Never throw. A failure returns null and the caller uses the free path.
 *
 * Caching is the callers' job (see travel.ts), because only they know what a
 * repeat question looks like.
 */

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';

const TIMEOUT_MS = 2_500;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Test seam: `{ key, fetch }` turns Google on with a fake transport; null restores. */
let testOverride: { key: string } | null = null;

export function __setGoogleForTest(o: { key: string; fetch: FetchLike } | null): void {
  if (o) {
    testOverride = { key: o.key };
    fetchImpl = o.fetch;
  } else {
    testOverride = null;
    fetchImpl = (input, init) => fetch(input, init);
  }
}

function apiKey(): string | null {
  if (testOverride) return testOverride.key;
  // Under vitest nothing reaches Google unless a test asked for it: the suite
  // runs with the developer's .env, which may well hold a real key.
  if (process.env.VITEST) return null;
  if (config.GOOGLE_MAPS_ENABLED !== 'true') return null;
  return config.GOOGLE_MAPS_API_KEY ?? null;
}

export function isGoogleEnabled(): boolean {
  return apiKey() !== null;
}

async function send(
  sku: MapsSku,
  url: string,
  init: RequestInit,
  /** What was asked, for the dashboard's request log. */
  label: string,
): Promise<unknown | null> {
  const key = apiKey();
  if (!key) return null;
  if (!tryCharge(sku, new Date(), label)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.replace('{KEY}', encodeURIComponent(key)), {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'X-Goog-Api-Key': key },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ sku, status: res.status }, 'google maps request failed');
      logMapsEvent({ kind: 'google_failed', sku, label: `${label} (HTTP ${res.status})` });
      return null;
    }
    const body = await res.json();
    // The Geocoding web service reports refusals inside a 200.
    const status = (body as { status?: string } | null)?.status;
    if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
      logMapsEvent({ kind: 'google_failed', sku, label: `${label} (${status})` });
    } else {
      logMapsEvent({ kind: 'google', sku, label });
    }
    return body;
  } catch (err) {
    logger.warn({ sku, err: String(err) }, 'google maps request errored');
    logMapsEvent({ kind: 'google_failed', sku, label: `${label} (no answer)` });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Geocoding ───────────────────────────────────────────────────────────────

export interface ResolvedPlace {
  placeId: string | null;
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
}

export async function googleGeocode(
  text: string,
  opts: { language?: string; region?: string } = {},
): Promise<ResolvedPlace | null> {
  const q = text.trim();
  if (!q) return null;
  const params = new URLSearchParams({
    address: q,
    language: opts.language ?? 'he',
    region: opts.region ?? 'il',
  });
  // The Geocoding web service takes the key as a query parameter.
  const body = (await send(
    'geocoding',
    `${GEOCODE_URL}?${params.toString()}&key={KEY}`,
    { method: 'GET' },
    `כתובת: ${q}`,
  )) as {
    status?: string;
    results?: {
      place_id?: string;
      formatted_address?: string;
      geometry?: { location?: { lat: number; lng: number } };
    }[];
  } | null;
  const first = body?.status === 'OK' ? body.results?.[0] : undefined;
  const loc = first?.geometry?.location;
  if (!first || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  return {
    placeId: first.place_id ?? null,
    latitude: loc.lat,
    longitude: loc.lng,
    formattedAddress: first.formatted_address ?? null,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** "32.085,34.782" — enough to recognise a place in the log, no more. */
function fmt(p: LatLng): string {
  return `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;
}

export interface RouteResult {
  minutes: number;
  distanceKm: number;
  withTraffic: boolean;
}

/**
 * Driving time between two points.
 *
 * `traffic: false` → TRAFFIC_UNAWARE, billed as Routes Essentials.
 * `traffic: true`  → TRAFFIC_AWARE, billed as Routes Pro (twice the price).
 * The field mask asks for duration and distance only, which keeps both at
 * their base SKU.
 */
export async function googleRoute(
  from: LatLng,
  to: LatLng,
  opts: { traffic: boolean; departAt?: Date },
): Promise<RouteResult | null> {
  const waypoint = (p: LatLng) => ({
    location: { latLng: { latitude: p.latitude, longitude: p.longitude } },
  });
  const payload: Record<string, unknown> = {
    origin: waypoint(from),
    destination: waypoint(to),
    travelMode: 'DRIVE',
    routingPreference: opts.traffic ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
  };
  // Google rejects a departure time in the past; omit it and "now" is used.
  if (opts.traffic && opts.departAt && opts.departAt.getTime() > Date.now() + 60_000) {
    payload.departureTime = opts.departAt.toISOString();
  }
  const body = (await send(
    opts.traffic ? 'routes_pro' : 'routes_essentials',
    ROUTES_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify(payload),
    },
    `מסלול${opts.traffic ? ' עם פקקים' : ''}: ${fmt(from)} → ${fmt(to)}`,
  )) as { routes?: { duration?: string; distanceMeters?: number }[] } | null;
  const route = body?.routes?.[0];
  const seconds = route?.duration ? Number.parseFloat(route.duration) : NaN;
  if (!route || !Number.isFinite(seconds)) return null;
  return {
    minutes: Math.round(seconds / 60),
    distanceKm: Math.round(((route.distanceMeters ?? 0) / 1000) * 10) / 10,
    withTraffic: opts.traffic,
  };
}

// ── Places (New) — Nearby Search ────────────────────────────────────────────

/**
 * The agent's categories → Google place types (Table A). A category missing
 * here simply never falls back to Google; it stays on the OSM snapshot.
 */
export const CATEGORY_GOOGLE_TYPES: Record<string, string[]> = {
  shopping: ['shopping_mall', 'department_store', 'supermarket'],
  mall: ['shopping_mall', 'department_store'],
  supermarket: ['supermarket', 'grocery_store'],
  convenience: ['convenience_store'],
  pharmacy: ['pharmacy', 'drugstore'],
  restaurant: ['restaurant'],
  cafe: ['cafe', 'coffee_shop'],
  fast_food: ['fast_food_restaurant'],
  gas_station: ['gas_station'],
  gym: ['gym', 'fitness_center'],
  park: ['park'],
  hospital: ['hospital'],
  bank: ['bank'],
  hotel: ['hotel'],
  clothes: ['clothing_store'],
  bakery: ['bakery'],
  hairdresser: ['hair_salon', 'barber_shop'],
  school: ['school'],
  kindergarten: ['preschool'],
  playground: ['playground'],
  atm: ['atm'],
  doctor: ['doctor'],
  dentist: ['dentist', 'dental_clinic'],
  post_office: ['post_office'],
  electronics: ['electronics_store'],
  books: ['book_store'],
  mobile_phone: ['cell_phone_store'],
  butcher: ['butcher_shop'],
  cinema: ['movie_theater'],
  library: ['library'],
  museum: ['museum'],
  veterinary: ['veterinary_care'],
  florist: ['florist'],
  hardware: ['hardware_store'],
  jewelry: ['jewelry_store'],
  parking: ['parking'],
};

export interface GooglePlace {
  name: string;
  latitude: number;
  longitude: number;
  placeId: string;
  /** Only present when opening hours were asked for (Enterprise SKU). */
  openNow?: boolean;
}

/** Pro fields only. Adding any hours/rating field moves the request to Enterprise. */
export const NEARBY_FIELDS_PRO = 'places.id,places.displayName,places.location';
export const NEARBY_FIELDS_ENTERPRISE = `${NEARBY_FIELDS_PRO},places.currentOpeningHours.openNow`;

export async function googleNearby(
  center: LatLng,
  category: string,
  opts: { radiusMeters: number; limit: number; withOpenNow: boolean; language?: string },
): Promise<GooglePlace[] | null> {
  const types = CATEGORY_GOOGLE_TYPES[category];
  if (!types) return null;
  const body = (await send(opts.withOpenNow ? 'nearby_enterprise' : 'nearby_pro', NEARBY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-FieldMask': opts.withOpenNow ? NEARBY_FIELDS_ENTERPRISE : NEARBY_FIELDS_PRO,
    },
    body: JSON.stringify({
      // Primary type only: with `includedTypes` any place that lists the type
      // anywhere comes back — "supermarket" near Azrieli returned the
      // observation deck and a petrol-station shop.
      includedPrimaryTypes: types,
      maxResultCount: Math.min(20, Math.max(1, opts.limit)),
      rankPreference: 'DISTANCE',
      languageCode: opts.language ?? 'he',
      locationRestriction: {
        circle: {
          center: { latitude: center.latitude, longitude: center.longitude },
          radius: Math.min(50_000, Math.max(100, opts.radiusMeters)),
        },
      },
    }),
  }, `מקומות${opts.withOpenNow ? ' פתוחים עכשיו' : ''}: ${category} ליד ${fmt(center)}`)) as {
    places?: {
      id?: string;
      displayName?: { text?: string };
      location?: { latitude: number; longitude: number };
      currentOpeningHours?: { openNow?: boolean };
    }[];
  } | null;
  if (!body) return null;
  const out: GooglePlace[] = [];
  for (const p of body.places ?? []) {
    const name = p.displayName?.text?.trim();
    if (!p.id || !name || !p.location) continue;
    out.push({
      name,
      placeId: p.id,
      latitude: p.location.latitude,
      longitude: p.location.longitude,
      ...(opts.withOpenNow && typeof p.currentOpeningHours?.openNow === 'boolean'
        ? { openNow: p.currentOpeningHours.openNow }
        : {}),
    });
  }
  return out;
}
