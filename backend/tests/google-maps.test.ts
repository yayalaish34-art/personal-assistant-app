/**
 * google-maps.test.ts — the cost rules of the Google Maps layer.
 *
 * Every test here answers one question: was Google asked, and should it have
 * been? A fake transport counts the requests and records what was sent, so a
 * rule that leaks a paid call fails on the count, not on a mock's return value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

import { app } from '../src/app.js';
import { configSchema } from '../src/config.js';
import {
  __setGoogleForTest,
  isGoogleEnabled,
  googleGeocode,
  NEARBY_FIELDS_PRO,
  NEARBY_FIELDS_ENTERPRISE,
} from '../src/modules/maps/google.js';
import { __resetBudgetForTest, recentMapsEvents, spendReport } from '../src/modules/maps/budget.js';
import { __setPlaceStoreForTest, learnedNearby, LEARNED_TTL_MS } from '../src/modules/maps/place-store.js';
import {
  __clearTravelCachesForTest,
  drivingMinutes,
  findImpossibleLeg,
  findNearbySmart,
  gateLeg,
  travelMinutes,
  type Point,
} from '../src/modules/voice/travel.js';
import { __setPlacesForTest, type IndexedPlace } from '../src/modules/voice/places-index.js';
import {
  windowOrigin,
  computeOpportunityNudge,
  type VoiceTurnInput,
} from '../src/modules/voice/agent.js';

// ── Fake Google ─────────────────────────────────────────────────────────────

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let sent: Sent[] = [];
let reply: (s: Sent) => unknown = () => ({});

function useFakeGoogle(): void {
  __setGoogleForTest({
    key: 'test-key',
    fetch: async (url, init) => {
      const s: Sent = {
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      sent.push(s);
      return new Response(JSON.stringify(reply(s)), { status: 200 });
    },
  });
}

const routeReply = (seconds: number) => ({
  routes: [{ duration: `${seconds}s`, distanceMeters: 50_000 }],
});

const TLV: Point = { latitude: 32.0853, longitude: 34.7818 };
const JLM: Point = { latitude: 31.7683, longitude: 35.2137 };
const RAMAT_GAN: Point = { latitude: 32.0823, longitude: 34.8107 };

beforeEach(() => {
  sent = [];
  reply = () => ({});
  __resetBudgetForTest();
  __clearTravelCachesForTest();
  __setPlaceStoreForTest(null);
});

afterEach(() => {
  __setGoogleForTest(null);
  __setPlacesForTest(null);
  __resetBudgetForTest();
});

// ── Config ──────────────────────────────────────────────────────────────────

describe('config', () => {
  const base = { JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) };

  it('treats empty Google values (as copied from .env.example) as unset, not as a startup failure', () => {
    const r = configSchema.safeParse({
      ...base,
      GOOGLE_MAPS_API_KEY: '',
      GOOGLE_MAPS_ENABLED: '',
      GOOGLE_MAPS_DAILY_BUDGET_USD: '',
    });
    expect(r.success).toBe(true);
    expect(r.data?.GOOGLE_MAPS_API_KEY).toBeUndefined();
    expect(r.data?.GOOGLE_MAPS_ENABLED).toBe('true');
    expect(r.data?.GOOGLE_MAPS_DAILY_BUDGET_USD).toBe(5);
  });

  it('reads real values, trimming the key', () => {
    const r = configSchema.safeParse({
      ...base,
      GOOGLE_MAPS_API_KEY: '  abc  ',
      GOOGLE_MAPS_ENABLED: 'false',
      GOOGLE_MAPS_DAILY_BUDGET_USD: '2.5',
    });
    expect(r.data).toMatchObject({
      GOOGLE_MAPS_API_KEY: 'abc',
      GOOGLE_MAPS_ENABLED: 'false',
      GOOGLE_MAPS_DAILY_BUDGET_USD: 2.5,
    });
  });

  it('rejects a negative budget', () => {
    expect(configSchema.safeParse({ ...base, GOOGLE_MAPS_DAILY_BUDGET_USD: '-1' }).success).toBe(false);
  });
});

// ── Kill switch ─────────────────────────────────────────────────────────────

describe('enablement', () => {
  it('is off under the test runner unless a test turns it on, whatever .env holds', () => {
    expect(isGoogleEnabled()).toBe(false);
    useFakeGoogle();
    expect(isGoogleEnabled()).toBe(true);
  });

  it('sends nothing at all while off', async () => {
    expect(await drivingMinutes(TLV, JLM)).toBeNull();
    expect(await googleGeocode('עזריאלי')).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

// ── The gate: Google only in the band the floor cannot settle ───────────────

describe('gateLeg', () => {
  it('calls a journey whose floor does not fit impossible', () => {
    expect(gateLeg(40, 30)).toBe('impossible');
  });
  it('calls a gap of twice the floor plus 15 a fit', () => {
    expect(gateLeg(20, 55)).toBe('fits');
    expect(gateLeg(20, 120)).toBe('fits');
  });
  it('leaves only the band in between to a real route', () => {
    expect(gateLeg(20, 20)).toBe('tight');
    expect(gateLeg(20, 54)).toBe('tight');
  });
});

describe('findImpossibleLeg — when a route is paid for', () => {
  const at = (h: number, m = 0) => `2026-11-17T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const placed = (title: string, p: Point, start: string, end: string) => ({
    title,
    location: title,
    locationLat: p.latitude,
    locationLng: p.longitude,
    startsAt: start,
    endsAt: end,
  });

  it('does not ask for a route when the gap is plainly enough', async () => {
    let drives = 0;
    const leg = await findImpossibleLeg(
      [placed('TLV', TLV, at(8), at(9)), placed('JLM', JLM, at(13), at(14))],
      async () => { throw new Error('should not geocode an event with coordinates'); },
      async () => { drives += 1; return 60; },
    );
    expect(leg).toBeNull();
    expect(drives).toBe(0);
  });

  it('does not ask for a route when even the floor cannot make it', async () => {
    let drives = 0;
    const leg = await findImpossibleLeg(
      [placed('TLV', TLV, at(8), at(9)), placed('JLM', JLM, at(9, 10), at(10))],
      async () => null,
      async () => { drives += 1; return 60; },
    );
    expect(drives).toBe(0);
    expect(leg?.basis).toBe('floor');
    expect(leg?.availableMinutes).toBe(10);
  });

  it('asks once in the tight band, and warns when the real drive does not fit', async () => {
    const floor = travelMinutes(54); // ~ TLV–JLM straight line
    const gap = floor + 10; // tight: above the floor, below 2×floor+15
    expect(gateLeg(floor, gap)).toBe('tight');
    let drives = 0;
    const end = new Date(Date.parse(at(9)) + gap * 60_000).toISOString();
    const leg = await findImpossibleLeg(
      [placed('TLV', TLV, at(8), at(9)), placed('JLM', JLM, end, at(15))],
      async () => null,
      async () => { drives += 1; return gap + 25; },
    );
    expect(drives).toBe(1);
    expect(leg?.basis).toBe('route');
    expect(leg?.neededMinutes).toBe(gap + 25);
  });

  it('stays silent in the tight band when no real route is available', async () => {
    const floor = travelMinutes(54);
    const gap = floor + 10;
    const end = new Date(Date.parse(at(9)) + gap * 60_000).toISOString();
    const leg = await findImpossibleLeg(
      [placed('TLV', TLV, at(8), at(9)), placed('JLM', JLM, end, at(15))],
      async () => null,
      async () => null,
    );
    expect(leg).toBeNull();
  });
});

// ── Routes: SKU, field mask, cache ──────────────────────────────────────────

describe('drivingMinutes', () => {
  it('asks Routes Essentials with a two-field mask, and only once per pair', async () => {
    useFakeGoogle();
    reply = () => routeReply(3000);
    const a = await drivingMinutes(TLV, JLM);
    const b = await drivingMinutes(TLV, JLM);
    expect(a).toBe(50 + 5);
    expect(b).toBe(a);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body?.routingPreference).toBe('TRAFFIC_UNAWARE');
    expect(sent[0]!.headers['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters');
    expect(spendReport().dayCount.routes_essentials).toBe(1);
    expect(spendReport().dayCount.routes_pro).toBe(0);
  });

  it('bills traffic as Routes Pro and caches it separately', async () => {
    useFakeGoogle();
    reply = () => routeReply(3600);
    await drivingMinutes(TLV, JLM);
    await drivingMinutes(TLV, JLM, { traffic: true });
    await drivingMinutes(TLV, JLM, { traffic: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body?.routingPreference).toBe('TRAFFIC_AWARE');
    expect(spendReport().dayCount.routes_pro).toBe(1);
  });

  it('remembers a failed pair briefly instead of retrying every candidate', async () => {
    useFakeGoogle();
    reply = () => ({ routes: [] });
    expect(await drivingMinutes(TLV, JLM)).toBeNull();
    expect(await drivingMinutes(TLV, JLM)).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

// ── Budget ──────────────────────────────────────────────────────────────────

describe('daily budget', () => {
  it('stops sending at the ceiling and falls back instead of failing', async () => {
    useFakeGoogle();
    reply = () => routeReply(1200);
    __resetBudgetForTest(0.012); // room for two Essentials requests ($0.005 each)
    const pairs: [Point, Point][] = [[TLV, JLM], [TLV, RAMAT_GAN], [JLM, RAMAT_GAN]];
    const results = [];
    for (const [a, b] of pairs) results.push(await drivingMinutes(a, b));
    expect(sent).toHaveLength(2);
    expect(results[2]).toBeNull();
    expect(spendReport().daySpendUsd).toBeCloseTo(0.01, 5);
  });

  it('refuses a request that alone is over the ceiling', async () => {
    useFakeGoogle();
    __resetBudgetForTest(0.004);
    expect(await googleGeocode('עזריאלי')).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

// ── Nearby: Google first, learned, snapshot for fuel ────────────────────────

describe('findNearbySmart', () => {
  const FIXTURE: IndexedPlace[] = [
    { n: 'Super Yuda', lat: 32.0855, lon: 34.7820, t: 'shop=supermarket' },
    { n: 'Shufersal', lat: 32.0860, lon: 34.7830, t: 'shop=supermarket' },
    { n: 'Lonely Pharmacy', lat: 32.0870, lon: 34.7840, t: 'amenity=pharmacy' },
  ];

  const googlePlaces = {
    places: [
      { id: 'g1', displayName: { text: 'Super-Pharm' }, location: { latitude: 32.0857, longitude: 34.7822 }, currentOpeningHours: { openNow: true } },
      { id: 'g2', displayName: { text: 'Night Pharmacy' }, location: { latitude: 32.0900, longitude: 34.7900 }, currentOpeningHours: { openNow: false } },
    ],
  };

  beforeEach(() => {
    __setPlacesForTest(FIXTURE);
  });

  it('trusts the snapshot only where it was measured to be good (fuel)', async () => {
    useFakeGoogle();
    __setPlacesForTest([
      ...FIXTURE,
      { n: 'Paz', lat: 32.0856, lon: 34.7821, t: 'amenity=fuel' },
      { n: 'Delek', lat: 32.0861, lon: 34.7831, t: 'amenity=fuel' },
    ]);
    const fuel = await findNearbySmart(TLV, 'gas_station');
    expect(fuel.source).toBe('osm');
    expect(sent).toHaveLength(0);
  });

  it('asks Google first for supermarkets even when the snapshot has some — it holds 6% of them', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    const r = await findNearbySmart(TLV, 'supermarket');
    expect(sent).toHaveLength(1);
    expect(r.source).toBe('google');
    expect(r.places.map((p) => p.name)).not.toContain('Super Yuda');
  });

  it('asks for a full page with Pro fields, and the same question later is answered from the learned store', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    const r = await findNearbySmart(TLV, 'pharmacy');
    expect(sent[0]!.headers['X-Goog-FieldMask']).toBe(NEARBY_FIELDS_PRO);
    expect(sent[0]!.body!.maxResultCount).toBe(20);
    expect(r.places.map((p) => p.name)).toEqual(['Super-Pharm', 'Night Pharmacy']);

    __clearTravelCachesForTest(); // the hour-long memory cache is gone; the store is not
    const again = await findNearbySmart(TLV, 'pharmacy');
    expect(sent).toHaveLength(1);
    expect(again.source).toBe('learned');
    expect(again.places.map((p) => p.name)).toEqual(['Super-Pharm', 'Night Pharmacy']);
    expect(spendReport().dayCount.nearby_pro).toBe(1);
  });

  it('a café search does not answer a supermarket question in the same street', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    await findNearbySmart(TLV, 'cafe');
    __clearTravelCachesForTest();
    await findNearbySmart(TLV, 'supermarket');
    expect(sent).toHaveLength(2);
  });

  it('a stored search answers only near where it was made', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    await findNearbySmart(TLV, 'pharmacy');
    __clearTravelCachesForTest();
    const elsewhere = { latitude: TLV.latitude + 0.025, longitude: TLV.longitude }; // ~2.8 km north
    await findNearbySmart(elsewhere, 'pharmacy');
    expect(sent).toHaveLength(2);
  });

  it('a full page of 20 is complete only out to its farthest result', async () => {
    useFakeGoogle();
    // 20 pharmacies, all within ~250 m: there may well be more beyond them.
    reply = () => ({
      places: Array.from({ length: 20 }, (_, i) => ({
        id: `p${i}`,
        displayName: { text: `Pharmacy ${i}` },
        location: { latitude: TLV.latitude + i * 0.0001, longitude: TLV.longitude },
      })),
    });
    await findNearbySmart(TLV, 'pharmacy');
    const covered = await learnedNearby('pharmacy', TLV, 3000);
    expect(covered?.length).toBeGreaterThanOrEqual(2); // the nearest ones are certain
    const oneKmAway = { latitude: TLV.latitude + 0.009, longitude: TLV.longitude };
    expect(await learnedNearby('pharmacy', oneKmAway, 3000)).toBeNull();
  });

  it('forgets what Google said after 30 days, as its terms require', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    await findNearbySmart(TLV, 'pharmacy');
    expect(await learnedNearby('pharmacy', TLV, 3000)).not.toBeNull();
    expect(await learnedNearby('pharmacy', TLV, 3000, Date.now() + LEARNED_TTL_MS + 60_000)).toBeNull();
  });

  it('a broken store never fails the question — it just goes to Google', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    const boom = async () => {
      throw new Error('db down');
    };
    __setPlaceStoreForTest({ searchesNear: boom, placesNear: boom, record: boom, purgeOlderThan: boom });
    const r = await findNearbySmart(TLV, 'pharmacy');
    expect(r.source).toBe('google');
    expect(r.places).toHaveLength(2);
  });

  it('pays for opening hours only when "open now" was asked, and drops the closed ones', async () => {
    useFakeGoogle();
    reply = () => googlePlaces;
    const r = await findNearbySmart(TLV, 'supermarket', { openNow: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['X-Goog-FieldMask']).toBe(NEARBY_FIELDS_ENTERPRISE);
    expect(r.openNowChecked).toBe(true);
    expect(r.places.map((p) => p.name)).toEqual(['Super-Pharm']);
  });

  it('says hours were not checked when "open now" is asked with Google off', async () => {
    const r = await findNearbySmart(TLV, 'supermarket', { openNow: true });
    expect(r.openNowChecked).toBe(false);
    expect(r.source).toBe('osm');
    expect(sent).toHaveLength(0);
  });
});

// ── By the calendar: where a window starts ──────────────────────────────────

describe('windowOrigin', () => {
  const base = (over: Partial<VoiceTurnInput['snapshot']['events'][number]>) => ({
    id: 'e1',
    title: 'Meeting in Ramat Gan',
    startsAt: '2026-11-17T13:00:00.000Z',
    endsAt: '2026-11-17T14:00:00.000Z',
    location: 'Ramat Gan',
    locationLat: RAMAT_GAN.latitude,
    locationLng: RAMAT_GAN.longitude,
    ...over,
  });
  const input = (events: ReturnType<typeof base>[], gps?: Point) =>
    ({
      snapshot: { tasks: [], events, shopping: [], money: [], debts: [], budgets: {} },
      location: gps,
      profile: undefined,
    }) as unknown as VoiceTurnInput;
  const now = Date.parse('2026-11-17T10:00:00.000Z');

  it('starts a later window at the meeting that ends just before it — no GPS needed', () => {
    const o = windowOrigin({ startsAt: '2026-11-17T14:15:00.000Z' }, input([base({})]), now);
    expect(o?.fromEvent).toBe('Meeting in Ramat Gan');
    expect(o?.point).toEqual(RAMAT_GAN);
  });

  it('prefers the meeting over current GPS for a window that has not opened yet', () => {
    const o = windowOrigin({ startsAt: '2026-11-17T14:15:00.000Z' }, input([base({})], TLV), now);
    expect(o?.fromEvent).toBe('Meeting in Ramat Gan');
  });

  it('uses GPS for a window already open', () => {
    const o = windowOrigin({ startsAt: '2026-11-17T10:00:00.000Z' }, input([base({})], TLV), now);
    expect(o).toEqual({ point: TLV });
  });

  it('ignores a meeting that ended long before the window', () => {
    const o = windowOrigin({ startsAt: '2026-11-17T18:00:00.000Z' }, input([base({})]), now);
    expect(o).toBeNull();
  });

  it('ignores a meeting with no coordinates', () => {
    const o = windowOrigin(
      { startsAt: '2026-11-17T14:15:00.000Z' },
      input([base({ locationLat: null, locationLng: null })]),
      now,
    );
    expect(o).toBeNull();
  });
});

describe('computeOpportunityNudge — by the calendar, without GPS', () => {
  it('offers the mall near the meeting that just ended, and says so', async () => {
    __setPlacesForTest([
      { n: 'קניון איילון', lat: 32.1000, lon: 34.8270, t: 'shop=mall' },
      { n: 'Far Mall', lat: 32.7893, lon: 35.0205, t: 'shop=mall' },
    ]);
    const nudge = await computeOpportunityNudge({
      text: '',
      language: 'he',
      timezone: 'Asia/Jerusalem',
      now: new Date('2026-11-17T12:00:00.000Z'), // 14:00 local
      history: [],
      snapshot: {
        tasks: [{ id: 't1', title: 'לקנות מתנה לרונית', isDone: false, postponeCount: 0 }],
        events: [
          {
            id: 'e1',
            title: 'פגישה ברמת גן',
            startsAt: '2026-11-17T11:00:00.000Z',
            endsAt: '2026-11-17T12:00:00.000Z',
            location: 'רמת גן',
            locationLat: RAMAT_GAN.latitude,
            locationLng: RAMAT_GAN.longitude,
          },
          { id: 'e2', title: 'אלירן', startsAt: '2026-11-17T14:00:00.000Z', endsAt: '2026-11-17T15:00:00.000Z' },
        ],
        shopping: [],
        money: [],
        debts: [],
        budgets: {},
      },
    } as unknown as VoiceTurnInput);
    expect(nudge.shouldNudge).toBe(true);
    expect(nudge.placeName).toBe('קניון איילון');
    expect(nudge.taskId).toBe('t1');
    expect(nudge.body).toContain('מ"פגישה ברמת גן"');
    expect(sent).toHaveLength(0);
  });

  it('stays quiet with neither GPS nor a placed meeting', async () => {
    const nudge = await computeOpportunityNudge({
      text: '',
      language: 'he',
      timezone: 'Asia/Jerusalem',
      now: new Date('2026-11-17T12:00:00.000Z'),
      history: [],
      snapshot: {
        tasks: [{ id: 't1', title: 'לקנות מתנה לרונית', isDone: false, postponeCount: 0 }],
        events: [],
        shopping: [],
        money: [],
        debts: [],
        budgets: {},
      },
    } as unknown as VoiceTurnInput);
    expect(nudge.shouldNudge).toBe(false);
  });
});

// ── Dashboard feed ──────────────────────────────────────────────────────────

describe('usage log for the dashboard', () => {
  it('logs a paid request and its cached repeat, counting only the repeat as saved', async () => {
    useFakeGoogle();
    reply = () => routeReply(1800);
    await drivingMinutes(TLV, JLM);
    await drivingMinutes(TLV, JLM);
    const kinds = recentMapsEvents().map((e) => e.kind);
    expect(kinds).toEqual(['cache', 'google']); // newest first
    expect(spendReport().monthSaved).toBe(1);
    expect(spendReport().monthCount.routes_essentials).toBe(1);
  });

  it('logs a request the ceiling refused as blocked, and sends nothing', async () => {
    useFakeGoogle();
    __resetBudgetForTest(0.001);
    await drivingMinutes(TLV, JLM);
    expect(recentMapsEvents()[0]?.kind).toBe('blocked');
    expect(sent).toHaveLength(0);
  });

  it('logs a geocode refused inside a 200 as failed, not as a success', async () => {
    useFakeGoogle();
    reply = () => ({ status: 'REQUEST_DENIED', error_message: 'billing' });
    expect(await googleGeocode('עזריאלי')).toBeNull();
    expect(recentMapsEvents()[0]).toMatchObject({ kind: 'google_failed' });
    expect(recentMapsEvents()[0]!.label).toContain('REQUEST_DENIED');
  });

  it('is not mounted outside development', async () => {
    expect((await request(app).get('/maps/dashboard')).status).toBe(404);
    expect((await request(app).get('/maps/usage')).status).toBe(404);
  });
});

// ── Routes on the wire ──────────────────────────────────────────────────────

describe('/maps/*', () => {
  it('POST /maps/resolve answers "disabled" without a key and sends nothing', async () => {
    const res = await request(app).post('/maps/resolve').send({ text: 'עזריאלי' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ place: null, source: 'disabled' });
    expect(sent).toHaveLength(0);
  });

  it('POST /maps/resolve geocodes once per distinct text', async () => {
    useFakeGoogle();
    reply = () => ({
      status: 'OK',
      results: [{ place_id: 'p1', formatted_address: 'Azrieli', geometry: { location: { lat: 32.074, lng: 34.792 } } }],
    });
    const first = await request(app).post('/maps/resolve').send({ text: 'Azrieli Center' });
    const second = await request(app).post('/maps/resolve').send({ text: '  azrieli   center ' });
    expect(first.body.place).toMatchObject({ placeId: 'p1', latitude: 32.074, longitude: 34.792 });
    expect(second.body.place).toEqual(first.body.place);
    expect(sent).toHaveLength(1);
  });

  it('POST /maps/resolve rejects an empty text', async () => {
    const res = await request(app).post('/maps/resolve').send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST /maps/eta returns the floor without Google, marked as such', async () => {
    const res = await request(app).post('/maps/eta').send({ from: TLV, to: JLM });
    expect(res.status).toBe(200);
    expect(res.body.withTraffic).toBe(false);
    expect(res.body.minutes).toBe(travelMinutes(res.body.distanceKm));
  });

  it('POST /maps/eta uses live traffic when on, but not for a trip hours away', async () => {
    useFakeGoogle();
    reply = () => routeReply(3900);
    const soon = new Date(Date.now() + 90 * 60_000).toISOString();
    const later = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const live = await request(app).post('/maps/eta').send({ from: TLV, to: JLM, arriveBy: soon });
    const early = await request(app).post('/maps/eta').send({ from: TLV, to: RAMAT_GAN, arriveBy: later });
    expect(live.body).toMatchObject({ minutes: 65 + 5, withTraffic: true });
    expect(early.body.withTraffic).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body?.routingPreference).toBe('TRAFFIC_AWARE');
  });

  it('POST /maps/errand-fences picks shops for errand tasks from the snapshot, for free', async () => {
    useFakeGoogle();
    __setPlacesForTest([
      { n: 'Super-Pharm Dizengoff', lat: 32.0780, lon: 34.7740, t: 'amenity=pharmacy' },
      { n: 'Dizengoff Center', lat: 32.0754, lon: 34.7735, t: 'shop=mall' },
    ]);
    const res = await request(app)
      .post('/maps/errand-fences')
      .send({
        near: { latitude: 32.0750, longitude: 34.7730 },
        tasks: [
          { id: 't1', title: 'לקנות מתנה לרונית' },
          { id: 't2', title: 'להתקשר לאמא' },
          { id: 't3', title: 'לאסוף תרופות' },
        ],
      });
    expect(res.status).toBe(200);
    const byTask = Object.fromEntries(res.body.fences.map((f: { taskId: string; placeName: string }) => [f.taskId, f.placeName]));
    expect(byTask).toEqual({ t1: 'Dizengoff Center', t3: 'Super-Pharm Dizengoff' });
    expect(sent).toHaveLength(0);
  });

  it('POST /maps/errand-fences never returns more than asked', async () => {
    __setPlacesForTest(
      Array.from({ length: 10 }, (_, i) => ({ n: `Mall ${i}`, lat: 32.075 + i * 0.001, lon: 34.773, t: 'shop=mall' })),
    );
    const res = await request(app)
      .post('/maps/errand-fences')
      .send({
        near: { latitude: 32.075, longitude: 34.773 },
        tasks: [{ id: 'a', title: 'gift for dad' }],
        max: 2,
      });
    expect(res.body.fences).toHaveLength(2);
  });

  it('POST /maps/errand-fences fences a shared shop once, not once per task', async () => {
    __setPlacesForTest(
      Array.from({ length: 10 }, (_, i) => ({ n: `Mall ${i}`, lat: 32.075 + i * 0.001, lon: 34.773, t: 'shop=mall' })),
    );
    const res = await request(app)
      .post('/maps/errand-fences')
      .send({
        near: { latitude: 32.075, longitude: 34.773 },
        tasks: [{ id: 'a', title: 'gift for dad' }, { id: 'b', title: 'gift for mom' }],
      });
    const ids = res.body.fences.map((f: { id: string }) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });
});
