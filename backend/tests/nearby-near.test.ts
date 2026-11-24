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
import { describeHowFar, executeToolCall, resolveSearchCenter, type VoiceTurnInput } from '../src/modules/voice/agent.js';

const HOLON = { latitude: 32.0158, longitude: 34.7874 };
const WIX = { lat: 32.1624, lng: 34.8447 };

const PLACES: IndexedPlace[] = [
  { n: 'קניון חולון', lat: 32.0128, lon: 34.7795, t: 'shop=mall' },
  { n: 'קניון גני הרצליה', lat: 32.1625, lon: 34.8335, t: 'shop=mall' },
  { n: 'שבעת הכוכבים', lat: 32.1660, lon: 34.8270, t: 'shop=mall' },
];

let geocoded: string[] = [];
/** Google knows the Wix building and the town; anything else is unknown. */
let routed = 0;
/** Road distance the fake Routes API answers with: straight line × this. */
let roadFactor = 3;
function fakeGeocoder(known: Record<string, { lat: number; lng: number; address?: string }>) {
  __setGoogleForTest({
    key: 'test-key',
    fetch: async (url, init) => {
      if (url.includes('routes.googleapis')) {
        routed += 1;
        const req = JSON.parse(String(init?.body ?? '{}'));
        const a = req.origin.location.latLng;
        const b = req.destination.location.latLng;
        const km = distanceKm(a, b) * roadFactor;
        return new Response(
          JSON.stringify({ routes: [{ duration: `${Math.round(km * 90)}s`, distanceMeters: Math.round(km * 1000) }] }),
          { status: 200 },
        );
      }
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
        ? {
            status: 'OK',
            results: [{
              place_id: 'p1',
              formatted_address: hit.address ?? `${address}, רחוב 1, ישראל`,
              geometry: { location: { lat: hit.lat, lng: hit.lng } },
            }],
          }
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
  return JSON.parse(r.content) as {
    ok: boolean;
    places?: { name: string; howFar: string }[];
    searchedNear?: string;
    error?: string;
    instruction?: string;
  };
}

beforeEach(() => {
  geocoded = [];
  routed = 0;
  roadFactor = 3;
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

describe('the wrong town, or only the town', () => {
  const TOWN = { lat: 32.1663, lng: 34.8433, address: 'הרצליה, ישראל' };

  it('refuses a place the map found in another town — "בניין WIX הרצליה" came back in Tel Aviv', async () => {
    fakeGeocoder({
      'בניין WIX הרצליה': { lat: 32.1423, lng: 34.8, address: 'יוניצמן 5, תל אביב-יפו, ישראל' },
      'הרצליה': TOWN,
    });
    const r = await nearby({ category: 'mall', near: 'בניין WIX הרצליה' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('יוניצמן 5');
    expect(r.error).toContain('Do not search there');
  });

  it('says so when the map knew only the town, not the building', async () => {
    fakeGeocoder({ 'בניין וויקס הרצליה': TOWN, 'הרצליה': TOWN });
    const r = await nearby({ category: 'mall', near: 'בניין וויקס הרצליה' });
    expect(r.ok).toBe(true);
    expect(r.instruction).toContain('centre of הרצליה');
  });

  it('trusts an address that is in the named town', async () => {
    fakeGeocoder({
      'הנדיב 71 הרצליה': { lat: 32.1624, lng: 34.8447, address: 'הנדיב 71, הרצליה, ישראל' },
      'הרצליה': TOWN,
    });
    const c = await resolveSearchCenter('הנדיב 71 הרצליה', input());
    expect(c?.mismatch).toBeUndefined();
    expect(c?.approximate).toBeUndefined();
  });
});

describe('how far, said like a person', () => {
  it('a few hundred metres is a walk, with no route asked', () => {
    expect(describeHowFar(0.3, null, null, 'he')).toBe('5 דקות הליכה');
  });

  it('under 1.5 km gives both', () => {
    expect(describeHowFar(0.8, { km: 2.4, minutes: 7 }, null, 'he')).toBe('12 דקות הליכה, או 2.4 ק"מ, כ-7 דקות ברכב');
  });

  it('further is a drive, by road — never the straight line as if it were the drive', () => {
    expect(describeHowFar(2, { km: 3.1, minutes: 9 }, null, 'he')).toBe('3.1 ק"מ, כ-9 דקות ברכב');
  });

  it('with no road distance it says the straight line out loud', () => {
    expect(describeHowFar(2, null, null, 'he')).toBe('כ-2 ק"מ בקו אוויר');
  });

  it('on foot, a far place is flagged as a long walk', () => {
    expect(describeHowFar(2.5, null, 'walk', 'he')).toBe('39 דקות הליכה — רחוק ללכת');
  });

  it('in English too', () => {
    expect(describeHowFar(0.3, null, null, 'en')).toBe('5 min walk');
  });
});

describe('road distance in the answer', () => {
  it('asks for routes only beyond walking distance, and orders by road', async () => {
    fakeGeocoder({ 'בניין וויקס הרצליה': WIX });
    const r = await nearby({ category: 'mall', near: 'בניין וויקס הרצליה' });
    expect(routed).toBeGreaterThan(0);
    expect(r.places![0]!.howFar).toContain('ברכב');
  });

  it('a walking user gets no routes and walking times', async () => {
    fakeGeocoder({ 'בניין וויקס הרצליה': WIX });
    const r = await nearby({ category: 'mall', near: 'בניין וויקס הרצליה', travelMode: 'walk' });
    expect(routed).toBe(0);
    expect(r.places![0]!.howFar).toContain('הליכה');
  });
});

describe('the town is named the way the map names it', () => {
  it('"רחוב הרצל 50 חולון" found in Tel Aviv is reported against Holon, not "50 חולון"', async () => {
    const HOLON_TOWN = { lat: 32.0158, lng: 34.7874, address: 'חולון, ישראל' };
    fakeGeocoder({
      'רחוב הרצל 50 חולון': { lat: 32.0617, lng: 34.7708, address: 'הרצל 50, תל אביב-יפו, ישראל' },
      '50 חולון': HOLON_TOWN,
      'חולון': HOLON_TOWN,
    });
    const r = await nearby({ category: 'pharmacy', near: 'רחוב הרצל 50 חולון' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not in חולון.');
    expect(r.error).toContain('near: "חולון"');
  });
});

describe('where to buy: ask once when the need is vague', () => {
  it('the prompt tells her to search a specific place at once, ask one question for a vague one, and fall back to a mall', async () => {
    const { buildSystemPrompt } = await import('../src/modules/voice/agent.js');
    const p = buildSystemPrompt(input() as never);
    expect(p).toContain('WHERE TO BUY SOMETHING:');
    expect(p).toMatch(/specific kind of place[^\n]*call find_nearby at once/);
    expect(p).toMatch(/vague need[^\n]*ask ONE short question/);
    expect(p).toMatch(/do not know[^\n]*search mall[^\n]*Never ask a second question/);
  });

  it('still in the prompt with no GPS at all', async () => {
    const { buildSystemPrompt } = await import('../src/modules/voice/agent.js');
    const noGps = { ...input(), location: undefined };
    expect(buildSystemPrompt(noGps as never)).toContain('WHERE TO BUY SOMETHING:');
  });
});
