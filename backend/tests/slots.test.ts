/**
 * slots.test.ts — Finding a free hour, and knowing when a journey cannot be made.
 *
 * Pure logic, no network: the geocoder is injected, so the rules about who can
 * get where in time are checked against fixed coordinates rather than against
 * whatever a third party says today.
 *
 * Times are written in `Asia/Jerusalem` with explicit offsets, because every
 * rule here — "the same day", "not before eight" — is a wall-clock rule and
 * means nothing without a zone.
 */

import { describe, it, expect } from 'vitest';

import { findFreeSlots, findClash, toZonedIso } from '../src/modules/voice/slots.js';
import {
  findImpossibleLeg,
  distanceKm,
  travelMinutes,
  type Point,
} from '../src/modules/voice/travel.js';

const TZ = 'Asia/Jerusalem'; // +03:00 in August

/** 2026-08-20 is a Thursday, well clear of any clock change. */
const day = (hhmm: string) => `2026-08-20T${hhmm}:00+03:00`;
const nextDay = (hhmm: string) => `2026-08-21T${hhmm}:00+03:00`;

/** The local hour:minute of an ISO string, for readable assertions. */
const at = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

const dayOf = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(new Date(iso));

const busyAll = () =>
  [{ startsAt: day('08:00'), endsAt: day('21:00') }];

// ─── Clash detection ─────────────────────────────────────────────────────────

describe('findClash', () => {
  it('1. an overlapping event is found', () => {
    const hit = findClash(day('10:00'), 60, [
      { startsAt: day('09:30'), endsAt: day('10:30'), title: 'Standup' } as never,
    ]);
    expect(hit).not.toBeNull();
  });

  it('2. an event that ends exactly when the new one starts is not a clash', () => {
    const hit = findClash(day('10:00'), 60, [
      { startsAt: day('09:00'), endsAt: day('10:00') } as never,
    ]);
    expect(hit).toBeNull();
  });

  it('3. an event with no end is treated as an hour long', () => {
    // 09:30 with no end runs to 10:30, so a 10:00 start collides.
    expect(findClash(day('10:00'), 60, [{ startsAt: day('09:30') } as never])).not.toBeNull();
    // 08:30 runs to 09:30 and leaves 10:00 alone.
    expect(findClash(day('10:00'), 60, [{ startsAt: day('08:30') } as never])).toBeNull();
  });

  it('4. an end before its start is not trusted, and falls back to an hour', () => {
    expect(
      findClash(day('10:00'), 60, [{ startsAt: day('09:30'), endsAt: day('08:00') } as never]),
    ).not.toBeNull();
  });

  it('5. an unparseable request clashes with nothing rather than throwing', () => {
    expect(findClash('not-a-date', 60, [{ startsAt: day('10:00') } as never])).toBeNull();
  });
});

// ─── Free slots ──────────────────────────────────────────────────────────────

describe('findFreeSlots', () => {
  it('6. an empty day offers four genuinely different times, best first', () => {
    const out = findFreeSlots(day('10:00'), 60, [], TZ);
    expect(out).toHaveLength(4);

    // Best first: the caller reads them in this order, so the ranking has to
    // survive the return rather than being re-sorted by the clock.
    const distance = (iso: string) =>
      Math.abs(new Date(iso).getTime() - new Date(day('10:00')).getTime());
    expect(distance(out[0]!)).toBeLessThanOrEqual(distance(out[1]!));

    // Four answers, not one answer four times.
    const times = out.map((iso) => new Date(iso).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(75 * 60_000);
    }
  });

  it('6b. ties go later — a meeting can be pushed back more easily than pulled forward', () => {
    const out = findFreeSlots(day('10:00'), 60, [], TZ);
    expect(at(out[0]!)).toBe('10:30');
  });

  it('7. the hour that is taken is not offered back', () => {
    const out = findFreeSlots(day('10:00'), 60, [
      { startsAt: day('10:00'), endsAt: day('11:00') },
    ], TZ);
    expect(out.map(at)).not.toContain('10:00');
  });

  it('8. nothing is offered before eight in the morning', () => {
    const out = findFreeSlots(day('08:30'), 60, [], TZ);
    for (const iso of out) expect(Number(at(iso).slice(0, 2))).toBeGreaterThanOrEqual(8);
  });

  it('9. a slot has to finish inside the day, not merely start inside it', () => {
    // A three-hour meeting cannot start at 19:00 and be done by 21:00.
    const out = findFreeSlots(day('19:00'), 180, [], TZ);
    for (const iso of out) {
      const end = new Date(new Date(iso).getTime() + 180 * 60_000).toISOString();
      expect(Number(at(end).slice(0, 2))).toBeLessThanOrEqual(21);
    }
  });

  it('10. a full day rolls over to the next one', () => {
    const out = findFreeSlots(day('10:00'), 60, busyAll(), TZ);
    expect(out.length).toBeGreaterThan(0);
    for (const iso of out) expect(dayOf(iso)).not.toBe(dayOf(day('10:00')));
  });

  it('11. today still beats tomorrow when today has room', () => {
    const out = findFreeSlots(day('10:00'), 60, [], TZ);
    for (const iso of out) expect(dayOf(iso)).toBe(dayOf(day('10:00')));
  });

  it('12. an unparseable request offers nothing rather than throwing', () => {
    expect(findFreeSlots('nope', 60, [], TZ)).toEqual([]);
  });

  it('13. a nonsense duration is clamped, not obeyed', () => {
    // Zero becomes the ten-minute floor rather than a meeting of no length.
    expect(findFreeSlots(day('10:00'), 0, [], TZ).length).toBeGreaterThan(0);

    // Three days becomes the eight-hour ceiling. Eight hours still fits inside
    // a day that runs 08:00–21:00, so slots come back — but only ones early
    // enough to finish, which is the part worth pinning down.
    const long = findFreeSlots(day('10:00'), 60 * 24 * 3, [], TZ);
    expect(long.length).toBeGreaterThan(0);
    for (const iso of long) {
      const end = new Date(new Date(iso).getTime() + 8 * 60 * 60_000);
      expect(Number(at(end.toISOString()).slice(0, 2))).toBeLessThanOrEqual(21);
    }
  });

  it('14. an event that cannot be parsed does not block the day', () => {
    const out = findFreeSlots(day('10:00'), 60, [{ startsAt: 'rubbish' }], TZ);
    expect(out.length).toBe(4);
  });

  it('15. the zone decides which day a slot lands on', () => {
    // 22:00 in Jerusalem is 19:00 UTC; the same instant is a different local
    // evening, so the offers differ.
    const jerusalem = findFreeSlots(day('22:00'), 60, [], TZ);
    const utc = findFreeSlots(day('22:00'), 60, [], 'UTC');
    expect(jerusalem[0]).not.toBe(utc[0]);
  });

  it('16. the offsets it emits are the zone’s own', () => {
    expect(toZonedIso(new Date(day('10:00')).getTime(), TZ)).toBe('2026-08-20T10:00:00+03:00');
    expect(toZonedIso(new Date(day('10:00')).getTime(), 'UTC')).toBe('2026-08-20T07:00:00+00:00');
  });
});

// ─── What the clock, the zone and the string are allowed to be ──────────────
//
// Every case below was a real defect found by reading this implementation
// rather than by imagining it.

describe('findFreeSlots — inputs it must survive', () => {
  const nowAt = (iso: string) => new Date(iso).getTime();

  it('31. nothing already gone is offered back', () => {
    // Quarter past nine, asking about a taken ten o'clock. Half past eight is
    // free on paper and useless in life.
    const out = findFreeSlots(
      day('10:00'),
      60,
      [{ startsAt: day('10:00'), endsAt: day('11:00') }],
      TZ,
      4,
      nowAt(day('09:15')),
    );
    for (const iso of out) {
      expect(new Date(iso).getTime()).toBeGreaterThan(nowAt(day('09:15')));
    }
  });

  it('32. a day that is entirely past rolls forward instead of emptying', () => {
    const out = findFreeSlots(day('10:00'), 60, [], TZ, 4, nowAt(day('20:55')));
    expect(out.length).toBeGreaterThan(0);
    for (const iso of out) expect(new Date(iso).getTime()).toBeGreaterThan(nowAt(day('20:55')));
  });

  it('33. a timezone that is not an IANA id falls back instead of throwing', () => {
    // A device can send a Windows name or a bare offset; Intl throws on both,
    // and unguarded that loses the whole turn to a 500.
    for (const zone of ['Israel Standard Time', 'GMT+2', 'UTC+3', '', 'Asia/Jerusalem ']) {
      expect(() => findFreeSlots(day('10:00'), 60, [], zone)).not.toThrow();
      expect(findFreeSlots(day('10:00'), 60, [], zone).length).toBeGreaterThan(0);
    }
  });

  it('34. a time with no offset is refused rather than read in the server’s zone', () => {
    // The same string would answer differently on a laptop in Jerusalem and on
    // a box running UTC. Silent three-hour errors are worse than none.
    expect(findFreeSlots('2026-08-20T10:00:00', 60, [], TZ)).toEqual([]);
    expect(findFreeSlots('2026-08-20', 60, [], TZ)).toEqual([]);
  });

  it('35. prose that is not a date is refused, including what does not go NaN', () => {
    // `new Date('tomorrow at 10')` is not Invalid Date — V8's fallback parser
    // returns a day in 2001 — so a NaN check alone lets it through.
    for (const junk of ['tomorrow at 10', 'next tuesday', '10 am', 'nope']) {
      expect(findFreeSlots(junk, 60, [], TZ)).toEqual([]);
    }
  });

  it('36. widening the pool does not make the answer worse', () => {
    // Ranking used to be thrown away by a final sort by clock time, so asking
    // for more candidates pushed the good ones out of the first four.
    const wanted = day('14:00');
    const busy = [{ startsAt: day('14:00'), endsAt: day('15:00') }];
    const wide = findFreeSlots(wanted, 60, busy, TZ, 16);
    const near = Math.abs(new Date(wide[0]!).getTime() - new Date(wanted).getTime());
    expect(near).toBeLessThanOrEqual(90 * 60_000);
  });
});

// ─── Distance and travel time ────────────────────────────────────────────────

const PLACES: Record<string, Point> = {
  jerusalem: { latitude: 31.769, longitude: 35.216 },
  haifa: { latitude: 32.816, longitude: 34.9899 },
  'tel aviv': { latitude: 32.0809, longitude: 34.7806 },
  'ramat gan': { latitude: 32.07, longitude: 34.824 },
};

const resolve = async (place: string): Promise<Point | null> =>
  PLACES[place.trim().toLowerCase()] ?? null;

describe('distance and travel time', () => {
  it('17. Jerusalem to Haifa is about 120 km', () => {
    const km = distanceKm(PLACES.jerusalem!, PLACES.haifa!);
    expect(km).toBeGreaterThan(100);
    expect(km).toBeLessThan(140);
  });

  it('18. the same point is no distance and no time', () => {
    expect(distanceKm(PLACES.haifa!, PLACES.haifa!)).toBeCloseTo(0);
    expect(travelMinutes(0)).toBe(0);
  });

  it('19. further is never quicker', () => {
    const steps = [1, 5, 20, 60, 150, 400].map(travelMinutes);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
  });

  it('20. even a short hop is not instant — leaving the room costs something', () => {
    expect(travelMinutes(1)).toBeGreaterThan(0);
  });
});

// ─── Can they actually get there? ────────────────────────────────────────────

describe('findImpossibleLeg', () => {
  it('21. Jerusalem at nine, Haifa at half past ten → impossible', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'Client', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'Site visit', location: 'Haifa', startsAt: day('10:30'), endsAt: day('11:30') },
      ],
      resolve,
    );
    expect(leg).not.toBeNull();
    expect(leg!.fromPlace).toBe('Jerusalem');
    expect(leg!.toPlace).toBe('Haifa');
    expect(leg!.neededMinutes).toBeGreaterThan(leg!.availableMinutes);
  });

  it('22. the same pair with a real gap is fine', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'Client', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'Site visit', location: 'Haifa', startsAt: day('14:00'), endsAt: day('15:00') },
      ],
      resolve,
    );
    expect(leg).toBeNull();
  });

  it('23. across town in half an hour is not flagged', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'A', location: 'Tel Aviv', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'B', location: 'Ramat Gan', startsAt: day('10:30'), endsAt: day('11:30') },
      ],
      resolve,
    );
    expect(leg).toBeNull();
  });

  it('24. two meetings in the same place are never a journey', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'A', location: 'Haifa', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'B', location: 'haifa ', startsAt: day('10:01'), endsAt: day('11:00') },
      ],
      resolve,
    );
    expect(leg).toBeNull();
  });

  it('25. an event with no place says nothing about where anyone is', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'A', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'B', startsAt: day('10:15'), endsAt: day('11:00') },
        { title: 'C', location: 'Haifa', startsAt: day('10:20'), endsAt: day('11:00') },
      ],
      resolve,
    );
    // A → C is still checked; B is simply not a stop.
    expect(leg).not.toBeNull();
    expect(leg!.toPlace).toBe('Haifa');
  });

  it('26. a place the geocoder does not know is not evidence of anything', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'A', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'B', location: 'Somewhere Nobody Has Heard Of', startsAt: day('10:05') },
      ],
      resolve,
    );
    expect(leg).toBeNull();
  });

  it('27. meetings that overlap in time are left to the clash check', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'A', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('11:00') },
        { title: 'B', location: 'Haifa', startsAt: day('10:00'), endsAt: day('12:00') },
      ],
      resolve,
    );
    expect(leg).toBeNull();
  });

  it('28. order in the array does not matter; order on the clock does', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'Later', location: 'Haifa', startsAt: day('10:30'), endsAt: day('11:30') },
        { title: 'Earlier', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('10:00') },
      ],
      resolve,
    );
    expect(leg!.fromTitle).toBe('Earlier');
    expect(leg!.toTitle).toBe('Later');
  });

  it('29. one meeting is never a journey', async () => {
    expect(
      await findImpossibleLeg(
        [{ title: 'A', location: 'Haifa', startsAt: day('09:00') }],
        resolve,
      ),
    ).toBeNull();
  });

  it('30. a gap spanning to the next day is plenty', async () => {
    const leg = await findImpossibleLeg(
      [
        { title: 'A', location: 'Jerusalem', startsAt: day('09:00'), endsAt: day('10:00') },
        { title: 'B', location: 'Haifa', startsAt: nextDay('09:00') },
      ],
      resolve,
    );
    expect(leg).toBeNull();
  });
});
