import { classify, DEFAULT_MINUTES } from './occasions.js';
import { geocode, distanceKm, travelMinutes, type Point } from './travel.js';

/**
 * "When am I free?" — answered by arithmetic rather than by reading a list.
 *
 * Until this existed the assistant answered that question by looking at the
 * agenda in her prompt and reasoning about it, which went wrong in three ways
 * that no amount of prompting fixes reliably:
 *
 *   - An event with no end time looked like a point on the clock, so an
 *     11:00 meeting left 11:00 itself "free".
 *   - Travel between places was invisible. Tel Aviv at 11:00 and Shoham at
 *     13:30 read as two and a half free hours in between.
 *   - A wedding at 20:30 read as an hour, so the rest of the evening looked
 *     open.
 *
 * All three are now computed here and handed to her as finished windows, with
 * the reason each one ends. She reports; she does not derive.
 *
 * The zone maths is deliberately the same shape as `slots.ts` — Intl in both
 * directions, no date library — because these two files have to agree about
 * what "today" means or they will contradict each other in the same sentence.
 */

export interface AvailabilityEvent {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
}

export interface FreeWindow {
  /** ISO with the user's own offset, so the client can print it directly. */
  startsAt: string;
  endsAt: string;
  minutes: number;
  /**
   * Why the window stops when it does. `travel` is the one worth saying out
   * loud — "until 12:40, because you need to leave for Shoham" is a different
   * and much more useful sentence than "until 12:40".
   */
  endsBecause: 'event' | 'travel' | 'sleep' | 'dayEnd';
  /** The event that closes it, when one does. */
  nextTitle?: string;
  nextPlace?: string;
  /** Minutes of travel that had to be carved off the end. */
  travelMinutes?: number;
}

export interface DayAvailability {
  /** Local YYYY-MM-DD. */
  date: string;
  windows: FreeWindow[];
  /**
   * Set when something that evening realistically ends the day — a wedding, a
   * flight. The caller uses it to skip the evening rather than offer 01:00.
   */
  eveningClosedBy?: string;
}

const MINUTE = 60_000;

/** Below this a gap is not usable time, it is just a gap. */
const MIN_USEFUL_MINUTES = 30;

/** Fallback waking window when no profile came with the turn. */
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 22;

/** Evening starts here, for "find me a time this evening". */
export const EVENING_START_HOUR = 17;

export interface AvailabilityPrefs {
  sleepStartHour: number;
  sleepEndHour: number;
  bufferMinutes: number;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const f: Record<string, string> = {};
  for (const p of parts) f[p.type] = p.value;
  return {
    year: Number(f.year),
    month: Number(f.month),
    day: Number(f.day),
    hour: Number(f.hour) % 24,
    minute: Number(f.minute),
    second: Number(f.second),
  };
}

function zoneOffset(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (instant - (instant % 1000));
}

function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

function toZonedIso(instant: number, timeZone: string): string {
  const p = localParts(instant, timeZone);
  const off = zoneOffset(instant, timeZone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(
    Math.floor(abs / 3_600_000),
  )}:${pad(Math.floor((abs % 3_600_000) / MINUTE))}`;
}

interface Booking {
  title: string;
  place: string | null;
  start: number;
  end: number;
  closesEvening: boolean;
}

/**
 * The day's events as real intervals.
 *
 * This is where the first bug dies: an event with no `endsAt` is given a
 * length rather than treated as a point. Which length depends on what it is —
 * an hour for a meeting, an evening for a wedding — which is what `occasions`
 * decides.
 */
function bookingsOf(events: AvailabilityEvent[]): Booking[] {
  const out: Booking[] = [];
  for (const e of events) {
    const start = new Date(e.startsAt).getTime();
    if (Number.isNaN(start)) continue;

    const rawEnd = e.endsAt ? new Date(e.endsAt).getTime() : NaN;
    const hasEnd = !Number.isNaN(rawEnd) && rawEnd > start;
    const occasion = classify(e.title);
    const end = hasEnd
      ? rawEnd
      : start + (occasion?.minutes ?? DEFAULT_MINUTES) * MINUTE;

    out.push({
      title: e.title,
      place: e.location?.trim() || null,
      start,
      end,
      // An explicit end time does not stop a wedding being a wedding: someone
      // who says it runs to midnight has still written off the evening.
      closesEvening: occasion?.closesEvening ?? false,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Merged, so two overlapping bookings do not produce a phantom gap. */
function mergeBookings(bookings: Booking[]): Booking[] {
  const merged: Booking[] = [];
  for (const b of bookings) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      // The later end wins, and with it the identity of whatever is still
      // running — that is the thing a window would be waiting for.
      if (b.end > last.end) {
        last.end = b.end;
        last.title = b.title;
        last.place = b.place;
      }
      last.closesEvening = last.closesEvening || b.closesEvening;
      continue;
    }
    merged.push({ ...b });
  }
  return merged;
}

function sleeping(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * The waking span of one local day, as instants.
 *
 * With a profile the day runs from waking to the start of sleep; without one
 * the old fixed window stands, so an install that never answered the
 * questionnaire behaves exactly as it did.
 */
function wakingSpan(
  year: number,
  month: number,
  day: number,
  timeZone: string,
  prefs?: AvailabilityPrefs,
): { start: number; end: number } {
  if (!prefs) {
    return {
      start: fromLocal(year, month, day, DAY_START_HOUR, 0, timeZone),
      end: fromLocal(year, month, day, DAY_END_HOUR, 0, timeZone),
    };
  }
  // Sleep that crosses midnight (23 → 7, the normal case) means the day runs
  // from the wake hour to the sleep hour on the same date. A window that does
  // not cross means someone sleeps in the afternoon; the same arithmetic still
  // produces their longest waking stretch.
  const wake = prefs.sleepEndHour;
  const bed = prefs.sleepStartHour;
  if (wake === bed) {
    return {
      start: fromLocal(year, month, day, 0, 0, timeZone),
      end: fromLocal(year, month, day + 1, 0, 0, timeZone),
    };
  }
  return {
    start: fromLocal(year, month, day, wake, 0, timeZone),
    end:
      bed > wake
        ? fromLocal(year, month, day, bed, 0, timeZone)
        : fromLocal(year, month, day + 1, bed, 0, timeZone),
  };
}

/**
 * How long the journey between two places needs, or null when it cannot be
 * known. Only ever called with two real place names — an event with no
 * location says nothing about where anyone has to be.
 */
async function legMinutes(
  from: string,
  to: string,
  resolve: (place: string) => Promise<Point | null>,
): Promise<number | null> {
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return 0;
  const [a, b] = await Promise.all([resolve(from), resolve(to)]);
  if (!a || !b) return null;
  return travelMinutes(distanceKm(a, b));
}

/**
 * The free windows on one local day.
 *
 * Travel is charged to the window *before* the journey, which is where it is
 * actually felt: the meeting in Shoham does not start earlier, but the free
 * time before it ends earlier, because leaving is part of the appointment.
 */
export async function freeWindowsForDay(
  date: string,
  events: AvailabilityEvent[],
  rawZone: string,
  now: number = Date.now(),
  prefs?: AvailabilityPrefs,
  resolve: (place: string) => Promise<Point | null> = geocode,
): Promise<DayAvailability> {
  const timeZone = safeZone(rawZone);
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return { date, windows: [] };

  const span = wakingSpan(y, m, d, timeZone, prefs);
  // Nothing already gone is free, so today starts from the clock.
  const from = Math.max(span.start, now);
  if (from >= span.end) return { date, windows: [] };

  const dayBookings = mergeBookings(
    bookingsOf(events).filter((b) => b.end > from && b.start < span.end),
  );

  const buffer = Math.max(0, prefs?.bufferMinutes ?? 0) * MINUTE;

  const eveningCloser = dayBookings.find((b) => {
    if (!b.closesEvening) return false;
    const p = localParts(b.start, timeZone);
    return p.hour >= EVENING_START_HOUR;
  });

  const windows: FreeWindow[] = [];
  let cursor = from;

  for (const booking of dayBookings) {
    // Time needed to get from wherever this window is spent to the booking.
    // Only charged when both ends name a place: a guess would invent journeys
    // nobody is making, and this figure shortens someone's real free time.
    let travel = 0;
    if (booking.place) {
      const previous = [...dayBookings]
        .filter((b) => b.end <= booking.start && b.place)
        .pop();
      if (previous?.place) {
        const mins = await legMinutes(previous.place, booking.place, resolve);
        if (mins !== null) travel = mins * MINUTE;
      }
    }

    const closesAt = booking.start - buffer - travel;
    const minutes = Math.round((closesAt - cursor) / MINUTE);
    if (minutes >= MIN_USEFUL_MINUTES) {
      windows.push({
        startsAt: toZonedIso(cursor, timeZone),
        endsAt: toZonedIso(closesAt, timeZone),
        minutes,
        endsBecause: travel > 0 ? 'travel' : 'event',
        nextTitle: booking.title,
        ...(booking.place ? { nextPlace: booking.place } : {}),
        ...(travel > 0 ? { travelMinutes: Math.round(travel / MINUTE) } : {}),
      });
    }
    cursor = Math.max(cursor, booking.end + buffer);
  }

  // Whatever is left between the last booking and bedtime.
  const tailMinutes = Math.round((span.end - cursor) / MINUTE);
  if (tailMinutes >= MIN_USEFUL_MINUTES) {
    windows.push({
      startsAt: toZonedIso(cursor, timeZone),
      endsAt: toZonedIso(span.end, timeZone),
      minutes: tailMinutes,
      endsBecause: prefs ? 'sleep' : 'dayEnd',
    });
  }

  return {
    date,
    windows,
    ...(eveningCloser ? { eveningClosedBy: eveningCloser.title } : {}),
  };
}

/** Local YYYY-MM-DD, `offset` days from the one given. */
export function addDays(date: string, offset: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const roll = new Date(Date.UTC(y || 1970, (m || 1) - 1, (d || 1) + offset));
  return `${roll.getUTCFullYear()}-${pad(roll.getUTCMonth() + 1)}-${pad(roll.getUTCDate())}`;
}

/** The local date `now` falls on. */
export function today(timeZone: string, now: number = Date.now()): string {
  const p = localParts(now, safeZone(timeZone));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export interface FindTimeResult {
  days: DayAvailability[];
  /** Days that were looked at and had nothing, with why. */
  skipped: { date: string; reason: 'eveningClosed' | 'full' }[];
}

/**
 * Walks forward until it finds days with real room.
 *
 * This is the part that makes "find me time this evening" behave: an evening
 * with a wedding in it is not offered a 23:30 window, it is skipped, and the
 * search moves to tomorrow. Which is what a person would do.
 */
export async function findTime(input: {
  fromDate: string;
  events: AvailabilityEvent[];
  timeZone: string;
  now?: number;
  prefs?: AvailabilityPrefs;
  /** Only windows overlapping the evening, for "sometime this evening". */
  eveningOnly?: boolean;
  /** How many days with room to return before stopping. */
  wantDays?: number;
  /** How far forward to look at all. */
  searchDays?: number;
  resolve?: (place: string) => Promise<Point | null>;
}): Promise<FindTimeResult> {
  const {
    fromDate,
    events,
    timeZone,
    now = Date.now(),
    prefs,
    eveningOnly = false,
    wantDays = 2,
    searchDays = 7,
    resolve = geocode,
  } = input;

  const days: DayAvailability[] = [];
  const skipped: FindTimeResult['skipped'] = [];
  const zone = safeZone(timeZone);

  for (let i = 0; i < searchDays && days.length < wantDays; i++) {
    const date = addDays(fromDate, i);
    const onDay = events.filter((e) => {
      const t = new Date(e.startsAt).getTime();
      if (Number.isNaN(t)) return false;
      const p = localParts(t, zone);
      return `${p.year}-${pad(p.month)}-${pad(p.day)}` === date;
    });

    const day = await freeWindowsForDay(date, onDay, zone, now, prefs, resolve);

    if (eveningOnly) {
      // An evening already spoken for is not a candidate at all — this is the
      // whole point of `closesEvening`. Offering the hours after a wedding is
      // technically true and practically useless.
      if (day.eveningClosedBy) {
        skipped.push({ date, reason: 'eveningClosed' });
        continue;
      }
      const eveningStart = fromLocal(
        Number(date.slice(0, 4)),
        Number(date.slice(5, 7)),
        Number(date.slice(8, 10)),
        EVENING_START_HOUR,
        0,
        zone,
      );
      const evening = day.windows.filter(
        (w) => new Date(w.endsAt).getTime() > eveningStart,
      );
      if (evening.length === 0) {
        skipped.push({ date, reason: 'full' });
        continue;
      }
      days.push({ ...day, windows: evening });
      continue;
    }

    if (day.windows.length === 0) {
      skipped.push({ date, reason: 'full' });
      continue;
    }
    days.push(day);
  }

  return { days, skipped };
}
