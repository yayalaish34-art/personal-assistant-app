import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../lib/logger.js';
import { distanceKm, type Point } from './travel-geo.js';

/**
 * A single OSM place after we have stripped it to the four fields the agent
 * actually asks about. Short keys keep the committed JSON small on disk and
 * cheap to parse at boot.
 */
export interface IndexedPlace {
  /** Display name (any language — most Israeli entries carry Hebrew). */
  n: string;
  lat: number;
  lon: number;
  /** The OSM tag the agent cares about, e.g. `shop=mall`, `amenity=cafe`. */
  t: string;
}

export interface PlacesSnapshot {
  generated: string;
  count: number;
  places: IndexedPlace[];
}

/**
 * The agent's category vocabulary → the OSM tags we accept for it. Must stay
 * in sync with what the dump script collects, or a category comes up empty.
 */
export const CATEGORY_OSM_TAGS: Record<string, string[]> = {
  shopping:    ['shop=mall', 'shop=department_store', 'shop=supermarket'],
  mall:        ['shop=mall', 'shop=department_store'],
  supermarket: ['shop=supermarket'],
  convenience: ['shop=convenience'],
  pharmacy:    ['amenity=pharmacy'],
  restaurant:  ['amenity=restaurant'],
  cafe:        ['amenity=cafe'],
  fast_food:   ['amenity=fast_food'],
  gas_station: ['amenity=fuel'],
  gym:         ['leisure=fitness_centre'],
  park:        ['leisure=park'],
  hospital:    ['amenity=hospital'],
  bank:        ['amenity=bank'],
  hotel:       ['tourism=hotel'],
  // Added for broader everyday coverage. Match real OSM tags; the dumper
  // picks them up automatically through ALL_DUMP_TAGS.
  clothes:      ['shop=clothes'],
  bakery:       ['shop=bakery'],
  hairdresser:  ['shop=hairdresser'],
  school:       ['amenity=school'],
  kindergarten: ['amenity=kindergarten'],
  playground:   ['leisure=playground'],
  atm:          ['amenity=atm'],
  doctor:       ['amenity=doctors'],
  dentist:      ['amenity=dentist'],
  post_office:  ['amenity=post_office'],
  // Second wave — common everyday destinations the agent might suggest.
  electronics:  ['shop=electronics'],
  books:        ['shop=books'],
  mobile_phone: ['shop=mobile_phone'],
  butcher:      ['shop=butcher'],
  greengrocer:  ['shop=greengrocer'],
  cinema:       ['amenity=cinema'],
  library:      ['amenity=library'],
  museum:       ['tourism=museum'],
  veterinary:   ['amenity=veterinary'],
  sports:       ['leisure=sports_centre'],
  // Third wave — large OSM categories to round out the catalogue.
  worship:      ['amenity=place_of_worship'],
  parking:      ['amenity=parking'],
  florist:      ['shop=florist'],
  hardware:     ['shop=hardware'],
  jewelry:      ['shop=jewelry'],
  optician:     ['shop=optician'],
};

/** All OSM tags the dump should ask Overpass about, deduped. */
export const ALL_DUMP_TAGS: string[] = Array.from(
  new Set(Object.values(CATEGORY_OSM_TAGS).flat()),
);

export interface NearbyHit {
  name: string;
  category: string;
  distanceKm: number;
  latitude: number;
  longitude: number;
}

/**
 * Pure lookup: given a set of places and a point, return the N closest ones
 * matching the category — within `radiusMeters`, deduped by name. No I/O, no
 * network. Everything the agent sees goes through this.
 */
export function findInPlaces(
  places: IndexedPlace[],
  center: Point,
  category: string,
  radiusMeters: number,
  limit: number,
): NearbyHit[] {
  const tags = CATEGORY_OSM_TAGS[category];
  if (!tags) return [];
  const accept = new Set(tags);
  const radiusKm = radiusMeters / 1000;

  // One pass over the file — cheap even at ~50k places (sub-ms on a laptop
  // once per voice turn). A spatial index would help if this ever gets hot;
  // today it is called at most twice per turn.
  const seen = new Set<string>();
  const hits: NearbyHit[] = [];
  for (const p of places) {
    if (!accept.has(p.t)) continue;
    const km = distanceKm(center, { latitude: p.lat, longitude: p.lon });
    if (km > radiusKm) continue;
    const key = p.n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      name: p.n,
      category,
      distanceKm: Math.round(km * 10) / 10,
      latitude: p.lat,
      longitude: p.lon,
    });
  }
  hits.sort((a, b) => a.distanceKm - b.distanceKm);
  return hits.slice(0, limit);
}

/**
 * Load the committed snapshot once per process. Missing or malformed → an
 * empty index and a warning. The agent degrades to "I don't see anything
 * nearby" rather than crashing, which is the right failure mode for a voice
 * turn.
 */
let cached: IndexedPlace[] | null = null;
let cacheLoadedFrom: string | null = null;
let testPinned = false;

function defaultSnapshotPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/modules/voice/places-index.ts → backend/data/places-il.json
  return resolvePath(here, '..', '..', '..', 'data', 'places-il.json');
}

export function loadPlaces(path = defaultSnapshotPath()): IndexedPlace[] {
  // A test fixture pins the cache so a path-mismatched call never silently
  // falls back to the real file (which would make the test's assertions race
  // against whatever shipped with the repo).
  if (testPinned && cached) return cached;
  if (cached && cacheLoadedFrom === path) return cached;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as PlacesSnapshot;
    if (!Array.isArray(parsed?.places)) {
      logger.warn({ path }, 'places snapshot has no `places` array');
      cached = [];
    } else {
      cached = parsed.places;
      logger.info(
        { path, count: cached.length, generated: parsed.generated },
        'places snapshot loaded',
      );
    }
  } catch (err) {
    logger.warn({ err: String(err), path }, 'places snapshot missing — nearby disabled');
    cached = [];
  }
  cacheLoadedFrom = path;
  return cached;
}

/** Test seam: let a test inject a fixture without touching the filesystem. */
export function __setPlacesForTest(places: IndexedPlace[] | null): void {
  if (places === null) {
    cached = null;
    cacheLoadedFrom = null;
    testPinned = false;
  } else {
    cached = places;
    cacheLoadedFrom = '<test>';
    testPinned = true;
  }
}

/**
 * The one function `travel.ts` calls. Local haversine over the snapshot,
 * same shape the Overpass path used to return — callers didn't change.
 */
export function findNearby(
  center: Point,
  category: string,
  radiusMeters = 3000,
  limit = 8,
): NearbyHit[] {
  return findInPlaces(loadPlaces(), center, category, radiusMeters, limit);
}
