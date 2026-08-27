/**
 * availability.test.ts — the five things the assistant used to get wrong.
 *
 * Every case here is one of the reported failures, written as the scenario it
 * came from rather than as a unit of the implementation. No network: the
 * geocoder is injected, so travel maths is exercised without a lookup.
 */

import { describe, it, expect } from 'vitest';

import {
  freeWindowsForDay,
  findTime,
  addDays,
  type AvailabilityEvent,
} from '../src/modules/voice/availability.js';
import { classify, occupiedMinutes } from '../src/modules/voice/occasions.js';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-03-10';

/** 2026-03-10 08:00 Jerusalem, so "now" is before everything in these days. */
const NOW = new Date('2026-03-10T06:00:00.000Z').getTime();

const PREFS = { sleepStartHour: 23, sleepEndHour: 7, bufferMinutes: 0 };

/** Jerusalem is +02:00 on this date. */
function at(hhmm: string, date = DATE): string {
  return `${date}T${hhmm}:00+02:00`;
}

/** Fixed coordinates, so distance is deterministic and no network is used. */
const PLACES: Record<string, { latitude: number; longitude: number }> = {
  'tel aviv': { latitude: 32.0853, longitude: 34.7818 },
  shoham: { latitude: 31.9993, longitude: 34.9482 },
  haifa: { latitude: 32.794, longitude: 34.9896 },
};
const resolve = async (place: string) => PLACES[place.trim().toLowerCase()] ?? null;

// ─── 1. An event with no end time is not a point on the clock ───────────────

describe('a meeting with no end time occupies an hour', () => {
  it('1. an 11:00 meeting leaves the next window starting at 12:00, not 11:00', async () => {
    const events: AvailabilityEvent[] = [{ title: 'Meeting', startsAt: at('11:00') }];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);

    const after = day.windows.find((w) => w.startsAt >= at('11:00'));
    expect(after).toBeDefined();
    expect(after!.startsAt).toBe(at('12:00'));
  });

  it('2. the window before it ends at 11:00, not later', async () => {
    const events: AvailabilityEvent[] = [{ title: 'Meeting', startsAt: at('11:00') }];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);

    expect(day.windows[0].endsAt).toBe(at('11:00'));
    expect(day.windows[0].nextTitle).toBe('Meeting');
  });

  it('3. an explicit end time is respected rather than overridden', async () => {
    const events: AvailabilityEvent[] = [
      { title: 'Meeting', startsAt: at('11:00'), endsAt: at('11:30') },
    ];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);

    const after = day.windows.find((w) => w.startsAt >= at('11:00'));
    expect(after!.startsAt).toBe(at('11:30'));
  });
});

// ─── 2. Travel between places eats the window before the journey ────────────

describe('travel between two places shortens the free window', () => {
  const events: AvailabilityEvent[] = [
    { title: 'Standup', startsAt: at('11:00'), location: 'Tel Aviv' },
    { title: 'Client', startsAt: at('13:30'), location: 'Shoham' },
  ];

  it('4. the gap does not run to 13:30 — it stops early for the drive', async () => {
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);
    const gap = day.windows.find((w) => w.startsAt === at('12:00'));

    expect(gap).toBeDefined();
    expect(new Date(gap!.endsAt).getTime()).toBeLessThan(new Date(at('13:30')).getTime());
  });

  it('5. it says the journey is why, and names where to', async () => {
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);
    const gap = day.windows.find((w) => w.startsAt === at('12:00'))!;

    expect(gap.endsBecause).toBe('travel');
    expect(gap.nextPlace).toBe('Shoham');
    expect(gap.travelMinutes).toBeGreaterThan(0);
  });

  it('6. two events at the same place cost no travel', async () => {
    const sameCity: AvailabilityEvent[] = [
      { title: 'Standup', startsAt: at('11:00'), location: 'Tel Aviv' },
      { title: 'Client', startsAt: at('13:30'), location: 'Tel Aviv' },
    ];
    const day = await freeWindowsForDay(DATE, sameCity, TZ, NOW, PREFS, resolve);
    const gap = day.windows.find((w) => w.startsAt === at('12:00'))!;

    expect(gap.endsBecause).toBe('event');
    expect(gap.endsAt).toBe(at('13:30'));
  });

  it('7. a place the geocoder cannot resolve charges no travel rather than guessing', async () => {
    const unknown: AvailabilityEvent[] = [
      { title: 'Standup', startsAt: at('11:00'), location: 'Tel Aviv' },
      { title: 'Client', startsAt: at('13:30'), location: 'Atlantis' },
    ];
    const day = await freeWindowsForDay(DATE, unknown, TZ, NOW, PREFS, resolve);
    const gap = day.windows.find((w) => w.startsAt === at('12:00'))!;

    expect(gap.endsBecause).toBe('event');
  });

  it('8. an event with no location is not given an invented journey', async () => {
    const partial: AvailabilityEvent[] = [
      { title: 'Standup', startsAt: at('11:00') },
      { title: 'Client', startsAt: at('13:30'), location: 'Shoham' },
    ];
    const day = await freeWindowsForDay(DATE, partial, TZ, NOW, PREFS, resolve);
    const gap = day.windows.find((w) => w.startsAt === at('12:00'))!;

    expect(gap.endsBecause).toBe('event');
  });
});

// ─── 3 & 5. A wedding is not an hour, and it ends the evening ───────────────

describe('special occasions are not ordinary hours', () => {
  it('9. a wedding is recognised and blocks far more than an hour', () => {
    const w = classify('חתונה של דנה');
    expect(w).not.toBeNull();
    expect(w!.minutes).toBeGreaterThanOrEqual(240);
    expect(w!.closesEvening).toBe(true);
  });

  it('10. English and Hebrew both match', () => {
    expect(classify('Dana and Yossi wedding')?.kind).toBe('wedding');
    expect(classify('טיסה לברלין')?.kind).toBe('flight');
    expect(classify('הופעה של שלמה ארצי')?.kind).toBe('show');
  });

  it('11. an ordinary meeting matches nothing and keeps the one-hour default', () => {
    expect(classify('פגישה עם רואה החשבון')).toBeNull();
    expect(occupiedMinutes('פגישה עם רואה החשבון', false)).toBe(60);
  });

  it('12. a 20:30 wedding does not leave 21:30 free that evening', async () => {
    const events: AvailabilityEvent[] = [{ title: 'חתונה של דנה', startsAt: at('20:30') }];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);

    expect(day.eveningClosedBy).toBe('חתונה של דנה');
    const late = day.windows.filter((w) => new Date(w.startsAt).getTime() >= new Date(at('21:00')).getTime());
    expect(late).toHaveLength(0);
  });
});

// ─── 4. Move to the next evening that actually works ────────────────────────

describe('finding the next evening that is genuinely usable', () => {
  it('13. an evening with a wedding is skipped, not offered late slots', async () => {
    const events: AvailabilityEvent[] = [{ title: 'חתונה', startsAt: at('20:30') }];
    const result = await findTime({
      fromDate: DATE,
      events,
      timeZone: TZ,
      now: NOW,
      prefs: PREFS,
      eveningOnly: true,
      wantDays: 1,
      resolve,
    });

    expect(result.skipped.some((s) => s.date === DATE && s.reason === 'eveningClosed')).toBe(true);
    expect(result.days[0]?.date).not.toBe(DATE);
  });

  it('14. and the evening it moves to is the next one, not days later', async () => {
    const events: AvailabilityEvent[] = [{ title: 'חתונה', startsAt: at('20:30') }];
    const result = await findTime({
      fromDate: DATE,
      events,
      timeZone: TZ,
      now: NOW,
      prefs: PREFS,
      eveningOnly: true,
      wantDays: 1,
      resolve,
    });

    expect(result.days[0]?.date).toBe(addDays(DATE, 1));
    expect(result.days[0]?.windows.length).toBeGreaterThan(0);
  });

  it('15. a free evening is returned as-is rather than skipped', async () => {
    const result = await findTime({
      fromDate: DATE,
      events: [],
      timeZone: TZ,
      now: NOW,
      prefs: PREFS,
      eveningOnly: true,
      wantDays: 1,
      resolve,
    });

    expect(result.days[0]?.date).toBe(DATE);
  });

  it('16. an ordinary evening meeting does not close the evening', async () => {
    const events: AvailabilityEvent[] = [
      { title: 'שיחה עם יוסי', startsAt: at('18:00') },
    ];
    const result = await findTime({
      fromDate: DATE,
      events,
      timeZone: TZ,
      now: NOW,
      prefs: PREFS,
      eveningOnly: true,
      wantDays: 1,
      resolve,
    });

    expect(result.days[0]?.date).toBe(DATE);
  });
});

// ─── Things it must survive ─────────────────────────────────────────────────

describe('inputs it must not fall over on', () => {
  it('17. an unparseable start time is dropped, not treated as midnight', async () => {
    const events: AvailabilityEvent[] = [
      { title: 'Broken', startsAt: 'tomorrow at ten' },
      { title: 'Meeting', startsAt: at('11:00') },
    ];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);
    expect(day.windows[0].endsAt).toBe(at('11:00'));
  });

  it('18. a timezone that is not an IANA id falls back instead of throwing', async () => {
    const day = await freeWindowsForDay(
      DATE,
      [{ title: 'Meeting', startsAt: at('11:00') }],
      'GMT+2',
      NOW,
      PREFS,
      resolve,
    );
    expect(Array.isArray(day.windows)).toBe(true);
  });

  it('19. overlapping events produce no phantom gap between them', async () => {
    const events: AvailabilityEvent[] = [
      { title: 'A', startsAt: at('11:00'), endsAt: at('13:00') },
      { title: 'B', startsAt: at('12:00'), endsAt: at('14:00') },
    ];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);
    const inside = day.windows.filter(
      (w) =>
        new Date(w.startsAt).getTime() >= new Date(at('11:00')).getTime() &&
        new Date(w.endsAt).getTime() <= new Date(at('14:00')).getTime(),
    );
    expect(inside).toHaveLength(0);
  });

  it('20. a gap too short to use is not offered as a window', async () => {
    const events: AvailabilityEvent[] = [
      { title: 'A', startsAt: at('11:00'), endsAt: at('12:00') },
      { title: 'B', startsAt: at('12:10'), endsAt: at('13:00') },
    ];
    const day = await freeWindowsForDay(DATE, events, TZ, NOW, PREFS, resolve);
    const tiny = day.windows.find((w) => w.startsAt === at('12:00'));
    expect(tiny).toBeUndefined();
  });

  it('21. nothing already past is offered as free', async () => {
    const lateNow = new Date('2026-03-10T14:00:00.000Z').getTime(); // 16:00 local
    const day = await freeWindowsForDay(DATE, [], TZ, lateNow, PREFS, resolve);
    for (const w of day.windows) {
      expect(new Date(w.endsAt).getTime()).toBeGreaterThan(lateNow);
    }
  });
});
