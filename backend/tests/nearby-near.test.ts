/**
 * nearby-near.test.ts — "where to buy" searches where the user will BE.
 *
 * The bug: the phone was in Holon, the user said "I'm meeting him at the Wix
 * building in Herzliya", and she sent him to the Holon mall — find_nearby
 * only ever searched around the GPS. Now `near` moves the search.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { __setGoogleForTest } from '../src/modules/maps/google.js';
import { __resetBudgetForTest } from '../src/modules/maps/budget.js';
import { __clearTravelCachesForTest } from '../src/modules/voice/travel.js';
import { distanceKm } from '../src/modules/voice/travel-geo.js';
import { __setPlaceStoreForTest } from '../src/modules/maps/place-store.js';
import { __setPlacesForTest, type IndexedPlace } from '../src/modules/voice/places-index.js';
import { executeToolCall, resolveSearchCenter, type VoiceTurnInput } from '../src/modules/voice/agent.js';

const HOLON = { latitude: 32.0158, longitude: 34.7874 };
const WIX = { lat: 32.1624, lng: 34.8447 };

const PLACES: IndexedPlace[] = [
  { n: 'קניון חולון', lat: 32.0128, lon: 34.7795, t: 'shop=mall' },
  { n: 'קניון גני הרצליה', lat: 32.1625, lon: 34.8335, t: 'shop=mall' },
  { n: 'שבעת הכוכבים', lat: 32.1660, lon: 34.8270, t: 'shop=mall' },
];

let geocoded: string[] = [];
/** Google knows the Wix building and the town; anything else is unknown. */
function fakeGeocoder(known: Record<string, { lat: number; lng: number }>) {
  __setGoogleForTest({
    key: 'test-key',
    fetch: async (url, init) => {
      if (!url.includes('/geocode/')) {
        // Nearby: the same malls, the ones within the requested circle.
        const req = JSON.parse(String(init?.body ?? '{}'));
        const c = req.locationRestriction.circle;
        const within = PLACES.filter(
          (p) => distanceKm(c.center, { latitude: p.lat, longitude: p.lon }) * 1000 <= c.radius,
        ).map((p, i) => ({ id: `g${i}${p.n}`, displayName: { text: p.n }, location: { latitude: p.lat, longitude: p.lon } }));
        return new Response(JSON.stringify({ places: within }), { status: 200 });
      }
      const address = new URL(url).searchParams.get('address') ?? '';
      geocoded.push(address);
      const hit = known[address];
      const body = hit
        ? { status: 'OK', results: [{ place_id: 'p1', formatted_address: address, geometry: { location: hit } }] }
        : { status: 'ZERO_RESULTS', results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
}

const input = (events: VoiceTurnInput['snapshot']['events'] = [], gps = HOLON) =>
  ({
    now: new Date('2026-11-23T10:00:00.000Z'),
    timezone: 'Asia/Jerusalem',
    language: 'he',
    location: gps,
    snapshot: { tasks: [], events, shopping: [], money: [], debts: [], budgets: {} },
  }) as unknown as VoiceTurnInput;

async function nearby(args: Record<string, unknown>, i = input()) {
  const r = await executeToolCall('find_nearby', JSON.stringify(args), i, []);
  return JSON.parse(r.content) as { ok: boolean; places?: { name: string }[]; searchedNear?: string; error?: string };
}

beforeEach(() => {
  geocoded = [];
  __resetBudgetForTest();
  __clearTravelCachesForTest();
  __setPlaceStoreForTest(null);
  __setPlacesForTest(PLACES);
  // Open-Meteo and Nominatim are not under test here: they find nothing.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setGoogleForTest(null);
  __setPlacesForTest(null);
});

describe('find_nearby with `near`', () => {
  it('searches around the Wix building, not the phone in Holon', async () => {
    fakeGeocoder({ 'בניין וויקס הרצליה': WIX });
    const r = await nearby({ category: 'mall', near: 'בניין וויקס הרצליה' });
    expect(r.ok).toBe(true);
    expect(r.places![0]!.name).toBe('קניון גני הרצליה');
    expect(r.places!.map((p) => p.name)).not.toContain('קניון חולון');
    expect(r.searchedNear).toBe('בניין וויקס הרצליה');
  });

  it('falls back to the town when the map does not know the building', async () => {
    fakeGeocoder({ 'הרצליה': { lat: 32.1663, lng: 34.8433 } });
    const r = await nearby({ category: 'mall', near: 'בניין וויקס הרצליה' });
    expect(r.places![0]!.name).not.toBe('קניון חולון');
    expect(geocoded).toContain('הרצליה');
  });

  it("uses a calendar event's saved coordinates without geocoding", async () => {
    fakeGeocoder({});
    const party = {
      id: 'e1',
      title: 'יום הולדת לחבר',
      startsAt: '2026-11-24T16:00:00.000Z',
      endsAt: '2026-11-24T19:00:00.000Z',
      location: 'בניין וויקס הרצליה',
      locationLat: WIX.lat,
      locationLng: WIX.lng,
    };
    const r = await nearby({ category: 'mall', near: 'יום הולדת לחבר' }, input([party] as never));
    expect(r.places![0]!.name).toBe('קניון גני הרצליה');
    expect(geocoded).toEqual([]);
  });

  it('says it cannot find the place rather than quietly using the GPS', async () => {
    fakeGeocoder({});
    const r = await nearby({ category: 'mall', near: 'מקום שלא קיים' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/do not fall back/);
  });

  it('still searches around the phone when no place was named', async () => {
    fakeGeocoder({});
    const r = await nearby({ category: 'mall' });
    expect(r.places![0]!.name).toBe('קניון חולון');
    expect(geocoded).toEqual([]);
  });

  it('works with no GPS at all once the user named a place', async () => {
    fakeGeocoder({ 'הרצליה': { lat: 32.1663, lng: 34.8433 } });
    const i = { ...input(), location: undefined } as unknown as VoiceTurnInput;
    const c = await resolveSearchCenter('הרצליה', i);
    expect(c?.point.latitude).toBeCloseTo(32.1663, 3);
    const r = await nearby({ category: 'mall', near: 'הרצליה' }, i);
    expect(r.ok).toBe(true);
  });
});
