/**
 * nearby-live.test.ts — exercises the agent's "see the environment" path.
 *
 * The old test mocked `fetch` because the real path hit the public Overpass
 * endpoint, which was at capacity most of the time. The real path now reads
 * `backend/data/places-il.json` and does haversine locally — no network, no
 * fetch to mock. We inject a fixture snapshot through the module's test seam
 * and exercise the same shape callers see.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { searchNearby } from '../src/modules/voice/travel.js';
import { answerSuggestOpportunity, type VoiceTurnInput } from '../src/modules/voice/agent.js';
import {
  __setPlacesForTest,
  findInPlaces,
  type IndexedPlace,
} from '../src/modules/voice/places-index.js';

// Dizengoff Center area — real coordinates.
const CENTER = { latitude: 32.0750, longitude: 34.7730 };

// A small Tel-Aviv-area fixture. Each entry is what the dumper writes: a
// name, lat, lon and the OSM tag it carries. Two "Dizengoff Center" entries
// stand in for the way+relation duplicate the dumper has to merge; the index
// dedupes by name at lookup time.
const FIXTURE: IndexedPlace[] = [
  { n: 'Dizengoff Center', lat: 32.0754, lon: 34.7735, t: 'shop=mall' },
  { n: 'Dizengoff Center', lat: 32.0754, lon: 34.7736, t: 'shop=mall' },
  { n: 'Gan HaIr',         lat: 32.0788, lon: 34.7804, t: 'shop=mall' },
  { n: 'TLV Fashion Mall', lat: 32.0825, lon: 34.7812, t: 'shop=mall' },
  { n: 'Shufersal Deal',   lat: 32.0763, lon: 34.7745, t: 'shop=supermarket' },
  { n: 'AM:PM Dizengoff',  lat: 32.0738, lon: 34.7720, t: 'shop=convenience' },
  { n: 'Hamashbir',        lat: 32.0740, lon: 34.7760, t: 'shop=department_store' },
  // Something far away — proves the radius filter actually filters.
  { n: 'Grand Kenyon Haifa', lat: 32.7893, lon: 35.0205, t: 'shop=mall' },
];

beforeEach(() => {
  __setPlacesForTest(FIXTURE);
});

afterEach(() => {
  __setPlacesForTest(null);
});

describe('searchNearby (local index)', () => {
  it('finds malls that live in the local snapshot', async () => {
    const malls = await searchNearby(CENTER, 'mall', 3000);
    const names = malls.map((p) => p.name);
    expect(names).toContain('Dizengoff Center');
    expect(names).toContain('Gan HaIr');
    expect(malls[0]!.name).toBe('Dizengoff Center');
    expect(malls[0]!.distanceKm).toBeLessThanOrEqual(0.2);
    // Sorted ascending by distance.
    for (let i = 1; i < malls.length; i += 1) {
      expect(malls[i]!.distanceKm).toBeGreaterThanOrEqual(malls[i - 1]!.distanceKm);
    }
  });

  it('dedupes duplicate names (way vs relation on real OSM)', async () => {
    const malls = await searchNearby(CENTER, 'mall', 3000);
    const dizengoff = malls.filter((p) => p.name === 'Dizengoff Center');
    expect(dizengoff).toHaveLength(1);
  });

  it('respects the radius — far-away malls are not returned', async () => {
    // Haifa is ~90km from Tel Aviv. Asking in a 3km bubble filters it out.
    const malls = await searchNearby(CENTER, 'mall', 3000);
    expect(malls.map((p) => p.name)).not.toContain('Grand Kenyon Haifa');
    // Open it up and Haifa should appear.
    const wider = findInPlaces(FIXTURE, CENTER, 'mall', 150_000, 20);
    expect(wider.map((p) => p.name)).toContain('Grand Kenyon Haifa');
  });

  it('returns supermarkets with real distances', async () => {
    const sm = await searchNearby(CENTER, 'supermarket', 2000);
    expect(sm.map((p) => p.name)).toContain('Shufersal Deal');
    expect(sm[0]!.distanceKm).toBeLessThan(0.3);
  });

  it('unions mall + department_store + supermarket when asked for "shopping"', async () => {
    const shops = await searchNearby(CENTER, 'shopping', 2000);
    expect(shops.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Dizengoff Center', 'Shufersal Deal', 'Hamashbir']),
    );
  });

  it('refuses categories outside the whitelist', async () => {
    const nothing = await searchNearby(CENTER, 'nightclub', 2000);
    expect(nothing).toEqual([]);
  });

  it('returns nothing when the snapshot is empty — never crashes', async () => {
    __setPlacesForTest([]);
    const malls = await searchNearby(CENTER, 'mall', 3000);
    expect(malls).toEqual([]);
  });
});

describe('answerSuggestOpportunity (shopping detour)', () => {
  it('joins GPS + free window + shopping list + nearby market into one offer', async () => {
    // Noon Jerusalem time on a Wednesday. Next event 15:00 — a 3h free window.
    const now = new Date('2026-07-29T09:00:00Z');
    const input: VoiceTurnInput = {
      text: 'מה אני יכולה לעשות עכשיו?',
      language: 'he',
      timezone: 'Asia/Jerusalem',
      now,
      history: [],
      snapshot: {
        tasks: [],
        events: [
          {
            id: 'e1',
            title: 'Eliran',
            startsAt: '2026-07-29T12:00:00Z', // 15:00 local
            endsAt: '2026-07-29T13:00:00Z',
          },
        ],
        shopping: [
          { id: 's1', name: 'חלב', isBought: false },
          { id: 's2', name: 'לחם', isBought: false },
          { id: 's3', name: 'ביצים', isBought: false },
        ],
        money: [],
        debts: [],
        budgets: {},
        currency: 'ILS',
      },
      location: { latitude: CENTER.latitude, longitude: CENTER.longitude, city: 'Tel Aviv' },
    };
    const actions: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await answerSuggestOpportunity({ minWindowMinutes: 20 }, input, actions as any);
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    if (result.fit?.kind === 'shopping_detour') {
      expect(result.fit.place.name).toBeTruthy();
      expect(result.fit.items.length).toBeGreaterThan(0);
      expect(result.fit.windowMinutes).toBeGreaterThanOrEqual(20);
    }
  });
});
