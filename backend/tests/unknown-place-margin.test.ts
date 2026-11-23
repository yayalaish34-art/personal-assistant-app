/**
 * unknown-place-margin.test.ts — an event with no place is not next door.
 *
 * The bug: "shopping" at 18:00–18:30 with no place, and she offered — and
 * booked — a meeting at 18:30, as if leaving the supermarket took no time.
 * Free windows now keep half an hour clear beside such an event, and booking
 * inside that half hour stops to ask instead of going through.
 */

import { describe, it, expect } from 'vitest';

import { freeWindowsForDay } from '../src/modules/voice/availability.js';
import { reviewSchedule, type KnownEvent } from '../src/modules/voice/schedule.js';

const ZONE = 'Asia/Jerusalem'; // UTC+2 in November
const DAY = '2026-11-24';
const NOW = Date.parse('2026-11-24T06:00:00.000Z'); // 08:00 local
const noGeo = async () => null;

const local = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 24, h! - 2, m!)).toISOString();
};

const lunch: KnownEvent = { id: 'e1', title: 'פגישה ב-12', startsAt: local('12:00'), endsAt: local('13:00') };
const shopping: KnownEvent = { id: 'e2', title: 'קניות בסופר', startsAt: local('18:00'), endsAt: local('18:30') };

const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

describe('free windows next to an event with no place', () => {
  it('does not open a window the minute the shopping ends', async () => {
    const day = await freeWindowsForDay(DAY, [lunch, shopping], ZONE, NOW, undefined, noGeo);
    const after = day.windows.find((w) => w.previousTitle === 'קניות בסופר')!;
    expect(clock(after.startsAt)).toBe('19:00');
    expect(after.unknownPlace).toMatchObject({ after: 'קניות בסופר', marginMinutes: 30 });
    expect(clock(after.earliestStartsAt!)).toBe('18:30');
  });

  it('stops the window before it half an hour early too', async () => {
    const day = await freeWindowsForDay(DAY, [lunch, shopping], ZONE, NOW, undefined, noGeo);
    const before = day.windows.find((w) => w.nextTitle === 'קניות בסופר')!;
    expect(clock(before.endsAt)).toBe('17:30');
    expect(before.unknownPlace?.before).toBe('קניות בסופר');
  });

  it("counts the user's own buffer towards the half hour, not on top of it", async () => {
    const prefs = { sleepStartHour: 23, sleepEndHour: 7, bufferMinutes: 45 };
    const day = await freeWindowsForDay(DAY, [shopping], ZONE, NOW, prefs, noGeo);
    const after = day.windows.find((w) => w.previousTitle === 'קניות בסופר')!;
    expect(clock(after.startsAt)).toBe('19:15'); // 18:30 + 45, no extra margin
  });

  it('keeps no extra margin beside an event that has a place', async () => {
    const placed = { ...shopping, location: 'שופרסל דיזנגוף' };
    const day = await freeWindowsForDay(DAY, [placed], ZONE, NOW, undefined, noGeo);
    const after = day.windows.find((w) => w.previousTitle === 'קניות בסופר')!;
    expect(clock(after.startsAt)).toBe('18:30');
    expect(after.unknownPlace).toBeUndefined();
  });
});

describe('booking next to an event with no place', () => {
  const at = (hhmm: string, minutes = 60) => ({
    title: 'פגישה עם דנה',
    startsAt: local(hhmm),
    endsAt: new Date(Date.parse(local(hhmm)) + minutes * 60_000).toISOString(),
  });

  it('asks before booking 18:30, right after the shopping', async () => {
    const v = await reviewSchedule(at('18:30'), [lunch, shopping], ZONE, undefined, NOW);
    expect(v.ok).toBe(false);
    if (v.ok || v.reason !== 'tight') throw new Error(`expected tight, got ${JSON.stringify(v)}`);
    expect(v.neighbour).toMatchObject({ title: 'קניות בסופר', side: 'after', gapMinutes: 0 });
    // What it offers instead is not tight itself.
    for (const o of v.options) {
      const start = Date.parse(o);
      expect(start >= Date.parse(local('19:00')) || start + 60 * 60_000 <= Date.parse(local('17:30'))).toBe(true);
    }
  });

  it('asks before a meeting that would end ten minutes before the shopping', async () => {
    const v = await reviewSchedule(at('16:50'), [shopping], ZONE, undefined, NOW);
    expect(v.ok === false && v.reason === 'tight' && v.neighbour.side === 'before').toBe(true);
  });

  it('books it once the user confirmed', async () => {
    const v = await reviewSchedule(at('18:30'), [lunch, shopping], ZONE, undefined, NOW, undefined, true);
    expect(v.ok).toBe(true);
  });

  it('books 19:00 without asking', async () => {
    const v = await reviewSchedule(at('19:00'), [lunch, shopping], ZONE, undefined, NOW);
    expect(v.ok).toBe(true);
  });

  it('a confirmation does not wave through a real clash', async () => {
    const v = await reviewSchedule(at('18:00'), [shopping], ZONE, undefined, NOW, undefined, true);
    expect(v.ok === false && v.reason === 'clash').toBe(true);
  });
});
