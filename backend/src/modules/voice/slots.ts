/**
 * Finding a free hour near the one that was asked for.
 *
 * All of this is wall-clock work — "the same day", "not before eight in the
 * morning" — which only means anything in the user's own zone. There is no
 * date library here, so the two conversions between an instant and a wall
 * clock are done with Intl and are the load-bearing part of the file.
 */

export interface SlotEvent {
  startsAt: string;
  endsAt?: string | null;
}

/**
 * The part of someone's questionnaire that this file can act on mechanically.
 *
 * Sleep and buffer only. Working hours are deliberately *not* here: enforcing
 * them would mean someone who works 9–5 could never be offered a seven o'clock
 * dinner, which is worse than the problem it solves. They go into the prompt
 * instead, where she can say "that is outside your hours, is that alright?" —
 * judgement, rather than a rule that cannot see what kind of thing is being
 * scheduled.
 */
export interface SlotPrefs {
  /** Asleep from → to, local hours. Crosses midnight when start > end. */
  sleepStartHour: number;
  sleepEndHour: number;
  /** Clear air kept either side of anything already in the diary. */
  bufferMinutes: number;
}

/** Slots start on the hour or the half hour. */
const SLOT_MINUTES = 30;
/**
 * The window used when no profile came with the turn — an install from before
 * the questionnaire existed, or someone who skipped it. Kept exactly as it was
 * so behaviour without a profile is unchanged.
 */
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 21;
/** An event with no end is treated as this long — the same default as create. */
const DEFAULT_MINUTES = 60;
/** Guards against a model that says 0 minutes, or 3 days. */
const MIN_MINUTES = 10;
const MAX_MINUTES = 8 * 60;

/** Nothing is offered closer than this to right now. */
const LEAD_MINUTES = 15;
/**
 * Offers have to be genuinely different answers. Ranked purely by closeness,
 * the four best are routinely the four half hours either side of one gap —
 * which is one option restated four times.
 */
const SEPARATION_MINUTES = 75;

const MINUTE = 60_000;

/**
 * A time is only a time if it says where on Earth it was written.
 *
 * `new Date('2026-08-10T10:00:00')` reads as the *server's* zone, so the same
 * request answers differently on a laptop in Jerusalem and on a box in UTC.
 * Worse, `new Date('tomorrow at 10')` is not NaN — V8's fallback parser
 * returns a date in 2001 — so the usual NaN guard lets it straight through.
 */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function instantOf(iso: string): number | null {
  if (!ISO_WITH_OFFSET.test(iso.trim())) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Intl throws on anything that is not an IANA id, and the zone arrives from a
 * device: a Windows name, `GMT+2`, a stray space. Unguarded that is a 500 and
 * the whole turn is lost. The sibling modules already fall back to UTC.
 */
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

/** The wall-clock fields an instant shows in a given zone. */
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
    // Some locales render midnight as 24; both mean the same wall clock.
    hour: Number(f.hour) % 24,
    minute: Number(f.minute),
    second: Number(f.second),
  };
}

/** How far ahead of UTC the zone is at that instant, in ms. */
function zoneOffset(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (instant - (instant % 1000));
}

/**
 * The instant at which a zone's clock reads the given wall time.
 *
 * Twice, because the offset that applies is the one at the answer, not the one
 * at the guess — and on the day the clocks move those differ. The second pass
 * lands on the right side of the change.
 */
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

/** An ISO string carrying the zone's own offset, which is what the client reads. */
export function toZonedIso(instant: number, timeZone: string): string {
  const p = localParts(instant, timeZone);
  const off = zoneOffset(instant, timeZone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const oh = pad(Math.floor(abs / 3_600_000));
  const om = pad(Math.floor((abs % 3_600_000) / MINUTE));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${oh}:${om}`;
}

interface Busy {
  start: number;
  end: number;
}

/**
 * The events as intervals, with the unusable ones dropped rather than guessed
 * at: an unparseable date is not a reason to offer someone a slot on top of a
 * meeting, and an end before its start says nothing trustworthy about either.
 */
function busyIntervals(events: SlotEvent[]): Busy[] {
  const out: Busy[] = [];
  for (const e of events) {
    const start = new Date(e.startsAt).getTime();
    if (Number.isNaN(start)) continue;
    const rawEnd = e.endsAt ? new Date(e.endsAt).getTime() : NaN;
    const end =
      Number.isNaN(rawEnd) || rawEnd <= start ? start + DEFAULT_MINUTES * MINUTE : rawEnd;
    out.push({ start, end });
  }
  return out;
}

function overlaps(start: number, end: number, busy: Busy[]): boolean {
  // Touching is not overlapping: an event ending at 10:00 leaves 10:00 free.
  return busy.some((b) => start < b.end && end > b.start);
}

/**
 * Is this local hour inside the sleep window?
 *
 * Written against the hour rather than the instant so that a window crossing
 * midnight — which is the normal case — is one comparison instead of two date
 * ranges. Equal start and end means nobody said, so nothing is excluded.
 */
function sleeping(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** The event already sitting across the requested time, if there is one. */
export function findClash<T extends SlotEvent>(
  requestedAtIso: string,
  durationMinutes: number,
  events: T[],
): T | null {
  const start = new Date(requestedAtIso).getTime();
  if (Number.isNaN(start)) return null;
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(durationMinutes)));
  const end = start + minutes * MINUTE;

  for (const e of events) {
    const [busy] = busyIntervals([e]);
    if (!busy) continue;
    if (start < busy.end && end > busy.start) return e;
  }
  return null;
}

/** How many days past the requested one to look, once that day is full. */
const DAYS_AHEAD = 6;

/**
 * Up to `limit` free starts near the one asked for.
 *
 * Closeness is the whole ranking, measured in real elapsed time: someone told
 * "your ten o'clock is taken" wants to hear about half past ten, not about
 * eight in the morning because it happened to come first in the day. The same
 * measure is what makes tomorrow appear only once today has nothing — a slot
 * the next morning is a day away, and loses to any hour still free today.
 *
 * Returns an empty array when the week genuinely has no room, which the caller
 * has to handle. Offering nothing is honest; inventing a slot at midnight is
 * not.
 */
export function findFreeSlots(
  requestedAtIso: string,
  durationMinutes: number,
  events: SlotEvent[],
  rawZone: string,
  limit = 4,
  /** Anything already past is not an alternative. Defaults to the clock. */
  now: number = Date.now(),
  /** From the questionnaire. Omitted, the fixed 08:00–21:00 window applies. */
  prefs?: SlotPrefs,
): string[] {
  const wanted = instantOf(requestedAtIso);
  if (wanted === null) return [];

  const timeZone = safeZone(rawZone);
  const earliest = now + LEAD_MINUTES * MINUTE;
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(durationMinutes)));
  const span = minutes * MINUTE;
  // Padded by the gap this person asked to keep, so a slot butting up against
  // an existing meeting is not offered as free. Only the offers are padded —
  // `findClash` still reports a real overlap, because "you already have
  // something then" and "that leaves you no gap" are different sentences.
  const pad = Math.max(0, prefs?.bufferMinutes ?? 0) * MINUTE;
  const busy = busyIntervals(events).map((b) => ({
    start: b.start - pad,
    end: b.end + pad,
  }));
  const asked = localParts(wanted, timeZone);

  // With a profile the whole clock is walked and sleep is what carves it up;
  // without one, the fixed daytime window stands.
  const firstHour = prefs ? 0 : DAY_START_HOUR;
  const lastHour = prefs ? 23 : DAY_END_HOUR;

  const candidates: number[] = [];

  for (let offset = 0; offset <= DAYS_AHEAD; offset++) {
    // Stepping the date field and letting Date.UTC normalise it is what keeps
    // month and year ends correct without any calendar arithmetic here.
    const roll = new Date(Date.UTC(asked.year, asked.month - 1, asked.day + offset));
    const y = roll.getUTCFullYear();
    const m = roll.getUTCMonth() + 1;
    const d = roll.getUTCDate();

    // Walk the day in half hours by wall clock rather than by adding
    // milliseconds, so a day that gains or loses an hour still produces real
    // local times instead of drifting off the grid.
    for (let hour = firstHour; hour <= lastHour; hour++) {
      for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
        const start = fromLocal(y, m, d, hour, minute, timeZone);
        // Never the hour that was asked for. This is only ever called because
        // that one does not work — on the clock or on the road — and handing
        // it back as an alternative reads as not having listened.
        if (start === wanted) continue;
        // Nor anything already gone. Without this, "your ten is taken" at a
        // quarter past nine answers with half past eight.
        if (start < earliest) continue;
        const end = start + span;

        if (prefs) {
          // Never while they are asleep — at either end. The end is measured a
          // moment before it lands, so a meeting finishing exactly as sleep
          // begins still counts as finishing before it.
          const last = localParts(end - 1, timeZone);
          if (
            sleeping(hour, prefs.sleepStartHour, prefs.sleepEndHour) ||
            sleeping(last.hour, prefs.sleepStartHour, prefs.sleepEndHour)
          ) {
            continue;
          }
        } else {
          // It has to finish inside the day too, not merely begin inside it.
          const endParts = localParts(end, timeZone);
          const endsSameDay =
            endParts.year === y && endParts.month === m && endParts.day === d;
          const endsInHours =
            endsSameDay &&
            (endParts.hour < DAY_END_HOUR ||
              (endParts.hour === DAY_END_HOUR && endParts.minute === 0));
          if (!endsInHours) continue;
        }

        if (overlaps(start, end, busy)) continue;
        candidates.push(start);
      }
    }

    // Enough near the asked-for day; no reason to keep walking the week.
    if (candidates.length >= limit * 3) break;
  }

  // Closeness decides, and ties go to the later one: a meeting can almost
  // always be taken later, whereas earlier means being somewhere sooner than
  // planned and usually needing the other side to agree.
  const ranked = candidates.sort(
    (a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || b - a,
  );

  // Spread, so four offers are four answers. Taken strictly in rank order and
  // skipping anything sitting on top of one already chosen.
  const picked: number[] = [];
  const gap = SEPARATION_MINUTES * MINUTE;
  for (const pass of [true, false]) {
    for (const c of ranked) {
      if (picked.length >= limit) break;
      if (picked.includes(c)) continue;
      // The second pass drops the spacing rule, so a day with only one free
      // pocket still fills the list rather than returning a single option.
      if (pass && picked.some((p) => Math.abs(p - c) < gap)) continue;
      picked.push(c);
    }
  }

  // Returned best-first. The caller decides the reading order; sorting by the
  // clock here would throw away the ranking before anyone could use it.
  return picked.map((t) => toZonedIso(t, timeZone));
}
