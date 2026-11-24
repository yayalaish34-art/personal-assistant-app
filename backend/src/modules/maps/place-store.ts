/**
 * The learned-places store: every Google "nearby" answer, kept for 30 days and
 * shared by all users, so the next question about the same area is free.
 *
 * Remembering places is not enough on its own. A list holding one café in
 * Dizengoff cannot say whether Dizengoff has no supermarket or whether nobody
 * has asked about supermarkets there yet. So each Google answer is stored
 * with the search that produced it: its centre, its category, and how far
 * from the centre the answer is complete (`coveredMeters`). Google ranks by
 * distance and returns at most 20, so an answer of fewer than 20 covers the
 * whole radius, and a full 20 covers out to the farthest of them.
 *
 * A later question at point Q is answered from the store only when some
 * stored search guarantees there is nothing nearer than what we hold: the
 * circle around Q out to the places we give back must lie inside that
 * search's covered circle. Otherwise the answer could be missing the very
 * shop around the corner, and it goes to Google.
 *
 * Google's terms allow keeping coordinates for 30 days, so older rows are
 * never read and are purged as new ones are written.
 *
 * Postgres when the server has a database; an in-memory store otherwise
 * (local runs without a database, and tests). A database error never fails
 * the user's question — it is logged and the search simply goes to Google.
 */

import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { distanceKm, type Point } from '../voice/travel-geo.js';

export const LEARNED_TTL_MS = 30 * 24 * 60 * 60_000;
/** Google returns at most this many per nearby request — the price is per request. */
export const GOOGLE_PAGE = 20;
/** A stored search further than this from the question is not looked at. */
const LOOKUP_KM = 5;
/** Fewer guaranteed places than this, and the user would want a fuller list. */
const MIN_PLACES = 2;
const PURGE_EVERY_MS = 60 * 60_000;

export interface LearnedPlace {
  placeId: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface PlaceSearchRecord {
  category: string;
  center: Point;
  coveredMeters: number;
  at: number;
}

interface StoredPlace extends LearnedPlace {
  category: string;
  savedAt: number;
}

export interface PlaceStore {
  searchesNear(category: string, center: Point, since: number): Promise<PlaceSearchRecord[]>;
  placesNear(category: string, center: Point, radiusKm: number, since: number): Promise<LearnedPlace[]>;
  record(search: PlaceSearchRecord, places: LearnedPlace[]): Promise<void>;
  purgeOlderThan(cutoff: number): Promise<void>;
}

/** A box around the centre, for a cheap indexed prefilter before the exact distance. */
function box(center: Point, km: number) {
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos((center.latitude * Math.PI) / 180)));
  return {
    latitude: { gte: center.latitude - dLat, lte: center.latitude + dLat },
    longitude: { gte: center.longitude - dLng, lte: center.longitude + dLng },
  };
}

export class MemoryPlaceStore implements PlaceStore {
  private searches: PlaceSearchRecord[] = [];
  private places = new Map<string, StoredPlace>();

  async searchesNear(category: string, center: Point, since: number) {
    return this.searches.filter(
      (s) => s.category === category && s.at >= since && distanceKm(center, s.center) <= LOOKUP_KM,
    );
  }

  async placesNear(category: string, center: Point, radiusKm: number, since: number) {
    return [...this.places.values()].filter(
      (p) => p.category === category && p.savedAt >= since && distanceKm(center, p) <= radiusKm,
    );
  }

  async record(search: PlaceSearchRecord, places: LearnedPlace[]) {
    this.searches.push(search);
    for (const p of places) {
      this.places.set(`${p.placeId}|${search.category}`, { ...p, category: search.category, savedAt: search.at });
    }
  }

  async purgeOlderThan(cutoff: number) {
    this.searches = this.searches.filter((s) => s.at >= cutoff);
    for (const [k, p] of this.places) if (p.savedAt < cutoff) this.places.delete(k);
  }
}

export class PrismaPlaceStore implements PlaceStore {
  async searchesNear(category: string, center: Point, since: number) {
    const rows = await prisma.placeSearch.findMany({
      where: { category, searchedAt: { gte: new Date(since) }, ...box(center, LOOKUP_KM) },
      take: 200,
    });
    return rows.map((r) => ({
      category: r.category,
      center: { latitude: r.latitude, longitude: r.longitude },
      coveredMeters: r.coveredMeters,
      at: r.searchedAt.getTime(),
    }));
  }

  async placesNear(category: string, center: Point, radiusKm: number, since: number) {
    const rows = await prisma.learnedPlace.findMany({
      where: { category, savedAt: { gte: new Date(since) }, ...box(center, radiusKm) },
      take: 500,
    });
    return rows
      .filter((r) => distanceKm(center, r) <= radiusKm)
      .map((r) => ({ placeId: r.placeId, name: r.name, latitude: r.latitude, longitude: r.longitude }));
  }

  async record(search: PlaceSearchRecord, places: LearnedPlace[]) {
    const savedAt = new Date(search.at);
    await prisma.$transaction([
      prisma.placeSearch.create({
        data: {
          category: search.category,
          latitude: search.center.latitude,
          longitude: search.center.longitude,
          coveredMeters: Math.round(search.coveredMeters),
          searchedAt: savedAt,
        },
      }),
      ...places.map((p) =>
        prisma.learnedPlace.upsert({
          where: { placeId_category: { placeId: p.placeId, category: search.category } },
          create: { ...p, category: search.category, savedAt },
          update: { name: p.name, latitude: p.latitude, longitude: p.longitude, savedAt },
        }),
      ),
    ]);
  }

  async purgeOlderThan(cutoff: number) {
    const before = new Date(cutoff);
    await prisma.$transaction([
      prisma.placeSearch.deleteMany({ where: { searchedAt: { lt: before } } }),
      prisma.learnedPlace.deleteMany({ where: { savedAt: { lt: before } } }),
    ]);
  }
}

let store: PlaceStore =
  config.DATABASE_URL && !process.env.VITEST ? new PrismaPlaceStore() : new MemoryPlaceStore();
let lastPurge = 0;

export function __setPlaceStoreForTest(s: PlaceStore | null): void {
  store = s ?? new MemoryPlaceStore();
  lastPurge = 0;
}

/**
 * What the store can answer for a question at `center` within `radiusMeters`,
 * or null when it cannot guarantee the answer is complete.
 */
export async function learnedNearby(
  category: string,
  center: Point,
  radiusMeters: number,
  now = Date.now(),
): Promise<LearnedPlace[] | null> {
  try {
    const since = now - LEARNED_TTL_MS;
    const searches = await store.searchesNear(category, center, since);
    // The search whose complete circle reaches furthest past this point.
    let slackKm = 0;
    for (const s of searches) {
      slackKm = Math.max(slackKm, s.coveredMeters / 1000 - distanceKm(center, s.center));
    }
    if (slackKm <= 0) return null;

    const wantedKm = radiusMeters / 1000;
    const guaranteedKm = Math.min(wantedKm, slackKm);
    const places = await store.placesNear(category, center, guaranteedKm, since);
    // A short list is still the whole truth when the guarantee spans the full
    // radius ("there are two pharmacies within 3 km"). Short of that, one
    // place could be the only one we happen to hold, so ask Google instead.
    if (places.length >= MIN_PLACES || guaranteedKm >= wantedKm) return places;
    return null;
  } catch (err) {
    logger.warn({ err }, 'learned places lookup failed; asking Google');
    return null;
  }
}

/** Keep a Google answer. `requestedMeters` is the radius that was sent. */
export async function rememberNearby(
  category: string,
  center: Point,
  requestedMeters: number,
  places: LearnedPlace[],
  now = Date.now(),
): Promise<void> {
  // A full page stops at its farthest result: beyond it there may be more.
  const coveredMeters =
    places.length >= GOOGLE_PAGE
      ? Math.max(0, ...places.map((p) => distanceKm(center, p) * 1000))
      : requestedMeters;
  try {
    await store.record({ category, center, coveredMeters, at: now }, places);
    if (now - lastPurge > PURGE_EVERY_MS) {
      lastPurge = now;
      await store.purgeOlderThan(now - LEARNED_TTL_MS);
    }
  } catch (err) {
    logger.warn({ err }, 'could not save learned places');
  }
}
