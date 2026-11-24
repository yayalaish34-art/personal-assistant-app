import { findFreeSlots, findClash, type SlotEvent, type SlotPrefs } from './slots.js';
import { findImpossibleLeg, type TravelLeg } from './travel.js';
import { UNKNOWN_PLACE_MINUTES } from './availability.js';

/**
 * Whether a proposed meeting can actually happen, and what to offer instead.
 *
 * Two ways it cannot. The hour is already taken, which any overlap check
 * finds. Or the hour is free but the person would have to be in two places —
 * Jerusalem at nine and Haifa at half past ten — which no overlap check finds,
 * because on the clock nothing overlaps at all.
 *
 * The alternatives are put through both tests as well. Told that ten o'clock
 * in Haifa is impossible because of a nine o'clock in Jerusalem, half past ten
 * is just as impossible, and offering it would be worse than offering nothing:
 * it looks like an answer.
 */

export interface ProposedEvent {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
  /** Carried over when the place itself is unchanged, so it is never re-geocoded. */
  locationLat?: number | null;
  locationLng?: number | null;
}

export interface KnownEvent extends SlotEvent {
  id: string;
  title: string;
  location?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
}

export type ScheduleVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: 'clash';
      clashWith: string;
      durationMinutes: number;
      options: string[];
    }
  | {
      ok: false;
      reason: 'travel';
      travel: TravelLeg;
      durationMinutes: number;
      options: string[];
    }
  | {
      ok: false;
      /**
       * Not impossible — unknown. A neighbour sits closer than half an hour
       * and one side has no place, so the journey cannot be worked out. The
       * agent asks before booking; a confirmed retry passes `allowTight`.
       */
      reason: 'tight';
      neighbour: TightNeighbour;
      durationMinutes: number;
      options: string[];
    };

export interface TightNeighbour {
  title: string;
  /** `after`: the new meeting would start soon after it ends. */
  side: 'before' | 'after';
  gapMinutes: number;
  /** The neighbour's place, when it has one (then the new one has none). */
  place?: string;
}

/**
 * The nearest event closer than `thresholdMinutes` to the proposal, where the
 * journey between them cannot be known because one side has no place. Both
 * placed is the travel check's business, and overlap the clash check's.
 */
export function findTightNeighbour(
  proposed: ProposedEvent,
  startsAt: string,
  minutes: number,
  others: KnownEvent[],
  thresholdMinutes: number,
): TightNeighbour | null {
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = start + minutes * MINUTE;
  const proposedPlace = proposed.location?.trim() || null;

  let best: TightNeighbour | null = null;
  for (const e of others) {
    const s = new Date(e.startsAt).getTime();
    if (Number.isNaN(s)) continue;
    const rawEnd = e.endsAt ? new Date(e.endsAt).getTime() : NaN;
    const eEnd = !Number.isNaN(rawEnd) && rawEnd > s ? rawEnd : s + DEFAULT_MINUTES * MINUTE;
    const place = e.location?.trim() || null;
    if (place && proposedPlace) continue;

    let gap: number;
    let side: 'before' | 'after';
    if (eEnd <= start) {
      gap = (start - eEnd) / MINUTE;
      side = 'after';
    } else if (s >= end) {
      gap = (s - end) / MINUTE;
      side = 'before';
    } else {
      continue;
    }
    if (gap >= thresholdMinutes) continue;
    if (!best || gap < best.gapMinutes) {
      best = { title: e.title, side, gapMinutes: Math.round(gap), ...(place ? { place } : {}) };
    }
  }
  return best;
}

const MINUTE = 60_000;
const DEFAULT_MINUTES = 60;
/** Generated before filtering, since travel knocks candidates out. */
const CANDIDATE_POOL = 16;
const OFFERED = 4;

function minutesOf(proposed: ProposedEvent): number {
  const start = new Date(proposed.startsAt).getTime();
  const end = proposed.endsAt ? new Date(proposed.endsAt).getTime() : NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return DEFAULT_MINUTES;
  return Math.round((end - start) / MINUTE);
}

/** The proposal as it would sit among the others, for checking against them. */
function withProposal(
  others: KnownEvent[],
  proposed: ProposedEvent,
  startsAt: string,
  minutes: number,
) {
  const start = new Date(startsAt).getTime();
  return [
    ...others,
    {
      title: proposed.title,
      location: proposed.location ?? null,
      locationLat: proposed.locationLat ?? null,
      locationLng: proposed.locationLng ?? null,
      startsAt,
      endsAt: new Date(start + minutes * MINUTE).toISOString(),
    },
  ];
}

export async function reviewSchedule(
  proposed: ProposedEvent,
  existing: KnownEvent[],
  timeZone: string,
  /** When moving an event, the row being moved must not be checked against itself. */
  ignoreId?: string,
  /** Threaded from the turn, so offers are never in the past. */
  now: number = Date.now(),
  /** From the questionnaire: what hours to keep clear, and how much air to leave. */
  prefs?: SlotPrefs,
  /** The user already heard about the tight neighbour and said book it. */
  allowTight = false,
): Promise<ScheduleVerdict> {
  const start = new Date(proposed.startsAt).getTime();
  if (Number.isNaN(start)) return { ok: true };

  const others = ignoreId ? existing.filter((e) => e.id !== ignoreId) : existing;
  const minutes = minutesOf(proposed);
  const tightThreshold = Math.max(UNKNOWN_PLACE_MINUTES, prefs?.bufferMinutes ?? 0);

  const clash = findClash(proposed.startsAt, minutes, others);
  const leg = clash
    ? null
    : await findImpossibleLeg(withProposal(others, proposed, proposed.startsAt, minutes));
  const tight =
    clash || leg || allowTight
      ? null
      : findTightNeighbour(proposed, proposed.startsAt, minutes, others, tightThreshold);

  if (!clash && !leg && !tight) return { ok: true };

  // Free by the clock first, then genuinely reachable. The pool is deliberately
  // wider than what gets offered, because the travel filter removes some.
  const pool = findFreeSlots(
    proposed.startsAt,
    minutes,
    others,
    timeZone,
    CANDIDATE_POOL,
    now,
    prefs,
  );
  const options: string[] = [];
  for (const candidate of pool) {
    if (options.length >= OFFERED) break;
    const stillStuck = await findImpossibleLeg(
      withProposal(others, proposed, candidate, minutes),
    );
    if (stillStuck) continue;
    // An alternative offered because of a tight neighbour must not be tight
    // itself — that would be the same question asked twice.
    if (findTightNeighbour(proposed, candidate, minutes, others, tightThreshold)) continue;
    options.push(candidate);
  }

  if (clash) {
    return {
      ok: false,
      reason: 'clash',
      clashWith: clash.title,
      durationMinutes: minutes,
      options,
    };
  }
  if (leg) {
    return { ok: false, reason: 'travel', travel: leg, durationMinutes: minutes, options };
  }
  return { ok: false, reason: 'tight', neighbour: tight!, durationMinutes: minutes, options };
}
