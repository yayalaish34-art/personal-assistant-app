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
 * Counts live in memory, so a restart resets them. That errs towards spending
 * a little more, not less, which is why Cloud Console quotas stay the second
 * fence.
 */

export type MapsSku =
  | 'geocoding'
  | 'routes_essentials'
  | 'routes_pro'
  | 'nearby_pro'
  | 'nearby_enterprise';

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

let counters: Counters = fresh(new Date());

function fresh(now: Date): Counters {
  const iso = now.toISOString();
  return {
    day: iso.slice(0, 10),
    month: iso.slice(0, 7),
    daySpendUsd: 0,
    dayCount: zeroCounts(),
    monthCount: zeroCounts(),
  };
}

function roll(now: Date): void {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const month = iso.slice(0, 7);
  if (month !== counters.month) {
    counters = fresh(now);
    return;
  }
  if (day !== counters.day) {
    counters = { ...counters, day, daySpendUsd: 0, dayCount: zeroCounts() };
  }
}

let budgetOverrideUsd: number | null = null;

function dailyBudget(): number {
  return budgetOverrideUsd ?? config.GOOGLE_MAPS_DAILY_BUDGET_USD;
}

/**
 * Reserve one request of `sku`. Returns false when it would cross today's
 * ceiling, in which case nothing is recorded and nothing should be sent.
 */
export function tryCharge(sku: MapsSku, now: Date = new Date()): boolean {
  roll(now);
  const price = SKU_PRICE_USD[sku];
  if (counters.daySpendUsd + price > dailyBudget() + 1e-9) {
    logger.warn(
      { sku, daySpendUsd: round(counters.daySpendUsd), budgetUsd: dailyBudget() },
      'maps.budget exhausted — using free path',
    );
    return false;
  }
  counters.daySpendUsd += price;
  counters.dayCount[sku] += 1;
  counters.monthCount[sku] += 1;
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
}

export function spendReport(now: Date = new Date()): SpendReport {
  roll(now);
  let billable = 0;
  for (const sku of Object.keys(SKU_PRICE_USD) as MapsSku[]) {
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
  };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Test seam. `null` restores the configured budget. */
export function __resetBudgetForTest(budgetUsd: number | null = null): void {
  counters = fresh(new Date());
  budgetOverrideUsd = budgetUsd;
}
