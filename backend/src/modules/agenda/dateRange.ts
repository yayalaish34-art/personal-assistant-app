/**
 * Timezone-aware date boundary helpers for /agenda.
 *
 * All dates are interpreted as wall-clock time in the user's IANA timezone.
 * Outputs are UTC Date objects suitable for Prisma queries.
 */

/**
 * Convert a 'YYYY-MM-DD' date string interpreted as midnight (start of day)
 * or end-of-day in the given IANA timezone to a UTC Date.
 *
 * Strategy: We construct a naive UTC Date from the date string at
 * 00:00:00Z (or 23:59:59.999Z), then use Intl to figure out what wall-clock
 * time that UTC instant corresponds to in the target timezone, compute the
 * offset, and correct the result so that the returned Date represents the
 * actual midnight (or 23:59:59.999) in that timezone.
 *
 * Falls back to UTC if the timezone name is invalid.
 */
export function toUtcDayBoundary(
  dateStr: string,
  tz: string,
  endOfDay = false,
): Date {
  // Validate IANA timezone; fall back to UTC on bad input.
  let safeTimezone = tz;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    safeTimezone = 'UTC';
  }

  const time = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';

  // Step 1: Pretend the wall-clock string is UTC to get an anchor Date.
  const naive = new Date(`${dateStr}${time}Z`);

  // Step 2: Render that UTC instant in the target timezone to discover
  // what wall-clock time it corresponds to there.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Parse the formatted parts back into a UTC-epoch Date
  // so we can compute the difference.
  const parts = formatter.formatToParts(naive);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

  const year = get('year');
  const month = get('month') - 1; // JS months are 0-based
  const day = get('day');
  let hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  // Intl with hour12:false may return 24 instead of 0 for midnight.
  if (hour === 24) hour = 0;

  // This is what the wall-clock looks like in tz for the naive UTC instant.
  const tzWallClock = Date.UTC(year, month, day, hour, minute, second);

  // The offset (ms) = naive UTC − tzWallClock.
  // Adding this to a wall-clock-as-UTC gives the real UTC equivalent.
  const offsetMs = naive.getTime() - tzWallClock;

  return new Date(naive.getTime() + offsetMs);
}

/**
 * Given a single 'YYYY-MM-DD' date, return [startUtc, endUtc) for that day
 * in the given timezone. endUtc is the start of the NEXT day (exclusive).
 */
export function dayRangeInTz(
  dateStr: string,
  tz: string,
): { start: Date; end: Date } {
  const start = toUtcDayBoundary(dateStr, tz, false);
  // End = start of the next calendar day in tz.
  // We compute it by incrementing the date string and finding its midnight.
  const nextDateStr = nextDay(dateStr);
  const end = toUtcDayBoundary(nextDateStr, tz, false);
  return { start, end };
}

/**
 * Given a from/to range (both inclusive), return [startUtc, endUtc).
 * endUtc is the start of the day AFTER `to` (exclusive upper bound).
 */
export function rangeInTz(
  fromStr: string,
  toStr: string,
  tz: string,
): { start: Date; end: Date } {
  const start = toUtcDayBoundary(fromStr, tz, false);
  const nextToStr = nextDay(toStr);
  const end = toUtcDayBoundary(nextToStr, tz, false);
  return { start, end };
}

/** Increment a YYYY-MM-DD string by one calendar day (UTC arithmetic is fine). */
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
