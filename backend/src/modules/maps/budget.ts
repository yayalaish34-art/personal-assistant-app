import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * What Google is allowed to cost us, and what it has cost so far.
 *
 * Every paid request asks `tryCharge(sku)` first. Past the daily ceiling the
 * answer is no, and the caller falls back to the free path instead of
 * failing — a slightly rougher travel estimate is always better than a turn
 * that errors.
 *
 * Counts are kept in memory and mirrored to `data/maps-usage.json` (git-
 * ignored), so a restart in the middle of a month does not forget what the
 * month has used. That file is per machine: on Railway it lives as long as
 * the container does, which is why Cloud Console quotas stay the second
 * fence.
 *
 * Alongside the counters sits a short event log — every Google request, and
 * every question answered for free instead (cache, local snapshot, the
 * straight-line gate). It feeds the local dashboard, so the savings can be
 * watched rather than taken on trust.
 */

export type MapsSku =
  | 'geocoding'
  | 'routes_essentials'
  | 'routes_pro'
  | 'nearby_pro'
  | 'nearby_enterprise';

export const ALL_SKUS: MapsSku[] = [
  'geocoding',
  'routes_essentials',
  'routes_pro',
  'nearby_pro',
  'nearby_enterprise',
];

/** List price per request, USD (Google Maps Platform, first tier). */
export const SKU_PRICE_USD: Record<MapsSku, number> = {
  geocoding: 5 / 1000,
  routes_essentials: 5 / 1000,
  routes_pro: 10 / 1000,
  nearby_pro: 32 / 1000,
  nearby_enterprise: 35 / 1000,
};

/** Free requests per calendar month, per billing account. */
export const SKU_FREE_PER_MONTH: Record<MapsSku, number> = {
  geocoding: 10_000,
  routes_essentials: 10_000,
  routes_pro: 5_000,
  nearby_pro: 5_000,
  nearby_enterprise: 1_000,
};

interface Counters {
  day: string;
  month: string;
  daySpendUsd: number;
  dayCount: Record<MapsSku, number>;
  monthCount: Record<MapsSku, number>;
  /** Questions answered without a paid request, this month. */
  monthSaved: number;
}

function zeroCounts(): Record<MapsSku, number> {
  return {
    geocoding: 0,
    routes_essentials: 0,
    routes_pro: 0,
    nearby_pro: 0,
    nearby_enterprise: 0,
  };
}

function fresh(now: Date): Counters {
  const iso = now.toISOString();
  return {
    day: iso.slice(0, 10),
    month: iso.slice(0, 7),
    daySpendUsd: 0,
    dayCount: zeroCounts(),
    monthCount: zeroCounts(),
    monthSaved: 0,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Never under the test runner: a test must not read or write a real file. */
const persist = !process.env.VITEST;

function usageFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/modules/maps/budget.ts → backend/data/maps-usage.json
  return resolvePath(here, '..', '..', '..', 'data', 'maps-usage.json');
}

function load(now: Date): Counters {
  const base = fresh(now);
  if (!persist) return base;
  try {
    const saved = JSON.parse(readFileSync(usageFilePath(), 'utf8')) as Partial<Counters>;
    if (saved.month !== base.month) return base; // a new month starts clean
    const sameDay = saved.day === base.day;
    return {
      ...base,
      monthCount: { ...zeroCounts(), ...(saved.monthCount ?? {}) },
      monthSaved: saved.monthSaved ?? 0,
      ...(sameDay
        ? {
            daySpendUsd: saved.daySpendUsd ?? 0,
            dayCount: { ...zeroCounts(), ...(saved.dayCount ?? {}) },
          }
        : {}),
    };
  } catch {
    return base; // no file yet, or unreadable: start from zero
  }
}

let saveTimer: NodeJS.Timeout | null = null;

/** Debounced, so a burst of requests costs one write. */
function scheduleSave(): void {
  if (!persist || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const path = usageFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(counters, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, 'maps usage file could not be written');
    }
  }, 1_000);
  saveTimer.unref?.();
}

let counters: Counters = load(new Date());

function roll(now: Date): void {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const month = iso.slice(0, 7);
  if (month !== counters.month) {
    counters = fresh(now);
    scheduleSave();
    return;
  }
  if (day !== counters.day) {
    counters = { ...counters, day, daySpendUsd: 0, dayCount: zeroCounts() };
    scheduleSave();
  }
}

// ── Event log (for the local dashboard) ─────────────────────────────────────

export type MapsEventKind =
  /** A request went to Google and was billed. */
  | 'google'
  /** Sent and billed, but Google answered with an error or nothing. */
  | 'google_failed'
  /** Not sent: today's ceiling was reached. */
  | 'blocked'
  /** Answered from a remembered Google answer. Free. */
  | 'cache'
  /** Answered from the local OSM snapshot or a free geocoder. Free. */
  | 'free'
  /** The straight-line floor settled it; no route was needed. Free. */
  | 'gate';

export interface MapsEvent {
  at: string;
  kind: MapsEventKind;
  sku?: MapsSku;
  /** Short human text — what was asked. Never contains a key. */
  label: string;
}

const EVENT_LOG_SIZE = 60;
const events: MapsEvent[] = [];

/** Record one lookup for the dashboard. Free kinds also count as "saved". */
export function logMapsEvent(e: Omit<MapsEvent, 'at'>, now: Date = new Date()): void {
  events.unshift({ ...e, label: e.label.slice(0, 120), at: now.toISOString() });
  if (events.length > EVENT_LOG_SIZE) events.length = EVENT_LOG_SIZE;
  if (e.kind === 'cache' || e.kind === 'free' || e.kind === 'gate') {
    roll(now);
    counters.monthSaved += 1;
    scheduleSave();
  }
}

export function recentMapsEvents(): MapsEvent[] {
  return events.slice();
}

// ── Budget ──────────────────────────────────────────────────────────────────

let budgetOverrideUsd: number | null = null;

function dailyBudget(): number {
  return budgetOverrideUsd ?? config.GOOGLE_MAPS_DAILY_BUDGET_USD;
}

/**
 * Reserve one request of `sku`. Returns false when it would cross today's
 * ceiling, in which case nothing is recorded and nothing should be sent.
 */
export function tryCharge(sku: MapsSku, now: Date = new Date(), label = ''): boolean {
  roll(now);
  const price = SKU_PRICE_USD[sku];
  if (counters.daySpendUsd + price > dailyBudget() + 1e-9) {
    logger.warn(
      { sku, daySpendUsd: round(counters.daySpendUsd), budgetUsd: dailyBudget() },
      'maps.budget exhausted — using free path',
    );
    logMapsEvent({ kind: 'blocked', sku, label: label || 'daily ceiling reached' }, now);
    return false;
  }
  counters.daySpendUsd += price;
  counters.dayCount[sku] += 1;
  counters.monthCount[sku] += 1;
  scheduleSave();
  const monthCount = counters.monthCount[sku];
  logger.info(
    {
      sku,
      daySpendUsd: round(counters.daySpendUsd),
      monthCount,
      monthFree: SKU_FREE_PER_MONTH[sku],
      billable: monthCount > SKU_FREE_PER_MONTH[sku],
    },
    'maps.spend',
  );
  return true;
}

export interface SpendReport {
  day: string;
  month: string;
  daySpendUsd: number;
  dailyBudgetUsd: number;
  dayCount: Record<MapsSku, number>;
  monthCount: Record<MapsSku, number>;
  /** Spend this month beyond the free allowance, at list price. */
  monthBillableUsd: number;
  /** Lookups answered without a paid request this month. */
  monthSaved: number;
}

export function spendReport(now: Date = new Date()): SpendReport {
  roll(now);
  let billable = 0;
  for (const sku of ALL_SKUS) {
    const over = Math.max(0, counters.monthCount[sku] - SKU_FREE_PER_MONTH[sku]);
    billable += over * SKU_PRICE_USD[sku];
  }
  return {
    day: counters.day,
    month: counters.month,
    daySpendUsd: round(counters.daySpendUsd),
    dailyBudgetUsd: dailyBudget(),
    dayCount: { ...counters.dayCount },
    monthCount: { ...counters.monthCount },
    monthBillableUsd: round(billable),
    monthSaved: counters.monthSaved,
  };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Test seam. `null` restores the configured budget. */
export function __resetBudgetForTest(budgetUsd: number | null = null): void {
  counters = fresh(new Date());
  budgetOverrideUsd = budgetUsd;
  events.length = 0;
}
