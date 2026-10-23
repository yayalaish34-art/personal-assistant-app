import type { Debt, ExpenseCategory, MoneyEntry } from './api';

// The arithmetic behind the finance screen, kept out of the screen so it can be
// read — and trusted — on its own. Months are local YYYY-MM strings, because
// every money row carries a plain local date and nothing here needs a zone.

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM of a local date, or of today. */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** The month `delta` months away from `key`. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

export function daysInMonth(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** "September 2026", in the reader's language. */
export function monthLabel(key: string, locale: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

/** Whether a typed date is a real YYYY-MM-DD — "2026-02-30" is not. */
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** A YYYY-MM-DD moved by whole days. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(y, m - 1, d + delta);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

// ── One month, added up ──────────────────────────────────────────────────────

export type MonthTotals = {
  income: number;
  expenses: number;
  balance: number;
  /** Spent per expense category, largest first. */
  byCategory: { category: ExpenseCategory | 'none'; amount: number }[];
};

export function totalsFor(entries: MoneyEntry[], month: string): MonthTotals {
  let income = 0;
  let expenses = 0;
  const cats = new Map<ExpenseCategory | 'none', number>();
  for (const e of entries) {
    if (!e.date.startsWith(month)) continue;
    if (e.kind === 'income') {
      income += e.amount;
    } else {
      expenses += e.amount;
      const key = (e.category as ExpenseCategory | null) ?? 'none';
      cats.set(key, (cats.get(key) ?? 0) + e.amount);
    }
  }
  return {
    income,
    expenses,
    balance: income - expenses,
    byCategory: [...cats.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** Open debts, each way. A single net figure hides which way the money goes. */
export function debtTotals(debts: Debt[]): { owe: number; owed: number } {
  let owe = 0;
  let owed = 0;
  for (const d of debts) {
    if (d.isSettled) continue;
    if (d.direction === 'owe') owe += d.amount;
    else owed += d.amount;
  }
  return { owe, owed };
}

// ── What the month is saying ─────────────────────────────────────────────────

export type Budgets = Partial<Record<ExpenseCategory, number>>;

/**
 * One observation, as a key and its values — the screen translates it. Tone
 * decides the colour: good news, a warning, or just a fact.
 */
export type Insight = {
  key: string;
  vars: Record<string, string | number>;
  tone: 'good' | 'warn' | 'info';
  /** A category the insight is about, so the screen can name it. */
  category?: ExpenseCategory | 'none';
};

/**
 * The few things worth saying about a month, most pressing first.
 *
 * Every figure is worked out here, from the rows, so the screen never shows a
 * number it did not compute. `today` is a parameter so a past month reads as
 * finished and the current one as under way.
 */
export function insightsFor(
  entries: MoneyEntry[],
  month: string,
  budgets: Budgets,
  money: (n: number) => string,
  today: Date = new Date(),
): Insight[] {
  const out: Insight[] = [];
  const now = totalsFor(entries, month);
  const prev = totalsFor(entries, shiftMonth(month, -1));
  const isCurrent = month === monthKey(today);
  const days = daysInMonth(month);
  const dayOfMonth = isCurrent ? today.getDate() : days;

  // Budgets first: an overspend is the one thing that should not be missed.
  for (const { category, amount } of now.byCategory) {
    if (category === 'none') continue;
    const limit = budgets[category];
    if (!limit) continue;
    if (amount > limit) {
      out.push({
        key: 'fin.insight.overBudget',
        vars: { over: money(amount - limit) },
        tone: 'warn',
        category,
      });
    } else if (isCurrent) {
      // On pace to go over: spent share well ahead of the month's share.
      const pace = (amount / dayOfMonth) * days;
      if (pace > limit && amount / limit >= 0.5) {
        out.push({
          key: 'fin.insight.budgetPace',
          vars: { pct: Math.round((amount / limit) * 100) },
          tone: 'warn',
          category,
        });
      }
    }
  }

  if (now.income > 0 || now.expenses > 0) {
    if (now.expenses > now.income && now.income > 0) {
      out.push({
        key: 'fin.insight.overspending',
        vars: { amount: money(now.expenses - now.income) },
        tone: 'warn',
      });
    } else if (now.income > 0) {
      const rate = Math.round((now.balance / now.income) * 100);
      if (rate > 0) out.push({ key: 'fin.insight.savingRate', vars: { pct: rate }, tone: 'good' });
    }
  }

  // Against last month, like for like: the current month is compared with the
  // same number of days of the one before, not with all of it.
  if (prev.expenses > 0 && now.expenses > 0) {
    const prevMonth = shiftMonth(month, -1);
    const cut = `${prevMonth}-${pad(Math.min(dayOfMonth, daysInMonth(prevMonth)))}`;
    const prevSoFar = isCurrent
      ? entries
          .filter((e) => e.kind === 'expense' && e.date.startsWith(prevMonth) && e.date <= cut)
          .reduce((s, e) => s + e.amount, 0)
      : prev.expenses;
    if (prevSoFar > 0) {
      const change = Math.round(((now.expenses - prevSoFar) / prevSoFar) * 100);
      if (Math.abs(change) >= 5) {
        out.push({
          key: change > 0 ? 'fin.insight.moreThanLast' : 'fin.insight.lessThanLast',
          vars: { pct: Math.abs(change) },
          tone: change > 0 ? 'warn' : 'good',
        });
      }
    }
  }

  if (now.expenses > 0) {
    out.push({
      key: 'fin.insight.dailyAverage',
      vars: { amount: money(Math.round(now.expenses / dayOfMonth)) },
      tone: 'info',
    });
    if (isCurrent && dayOfMonth < days && dayOfMonth >= 5) {
      out.push({
        key: 'fin.insight.projection',
        vars: { amount: money(Math.round((now.expenses / dayOfMonth) * days)) },
        tone: 'info',
      });
    }
    const top = now.byCategory[0];
    if (top && now.byCategory.length > 1) {
      out.push({
        key: 'fin.insight.topCategory',
        vars: { pct: Math.round((top.amount / now.expenses) * 100) },
        tone: 'info',
        category: top.category,
      });
    }
  }

  // What is still to come this month from the entries that repeat.
  if (isCurrent) {
    const due = upcomingRecurring(entries, month, today);
    const sum = due.reduce((s, e) => s + (e.kind === 'expense' ? e.amount : 0), 0);
    if (sum > 0) {
      out.push({
        key: 'fin.insight.upcoming',
        vars: { count: due.filter((e) => e.kind === 'expense').length, amount: money(sum) },
        tone: 'info',
      });
    }
  }

  return out;
}

// ── Entries that repeat every month ──────────────────────────────────────────

/** The day a repeating entry falls on in `month`, clamped to its last day. */
export function recurringDay(template: MoneyEntry, month: string): string {
  const day = Number(template.date.slice(8, 10));
  return `${month}-${pad(Math.min(day, daysInMonth(month)))}`;
}

/** The originals that repeat — a copy is never itself a source. */
export function templatesOf(entries: MoneyEntry[]): MoneyEntry[] {
  return entries.filter((e) => e.recurring && !e.recurringFrom);
}

/**
 * The copies a set of rows is missing, up to and including today.
 *
 * Each repeating original is copied into every month after its own, on the
 * same day of the month, once that day has come. A month the user deleted a
 * copy from is in `skipMonths` and stays empty. Nothing is made ahead of time:
 * rent on the 28th appears on the 28th, which is when it is real.
 */
export function missingRecurring(
  entries: MoneyEntry[],
  today: Date,
  make: (template: MoneyEntry, date: string) => MoneyEntry,
): MoneyEntry[] {
  const todayStr = `${monthKey(today)}-${pad(today.getDate())}`;
  const current = monthKey(today);
  const made: MoneyEntry[] = [];

  for (const t of templatesOf(entries)) {
    const have = new Set(
      entries.filter((e) => e.recurringFrom === t.id).map((e) => e.date.slice(0, 7)),
    );
    let month = shiftMonth(t.date.slice(0, 7), 1);
    // Bounded: a template dated years back must not run away on first open.
    for (let guard = 0; guard < 36 && month <= current; guard++, month = shiftMonth(month, 1)) {
      if (have.has(month) || t.skipMonths?.includes(month)) continue;
      const date = recurringDay(t, month);
      if (date > todayStr) continue;
      made.push(make(t, date));
    }
  }
  return made;
}

/** Repeating entries whose day in this month has not come yet. */
export function upcomingRecurring(entries: MoneyEntry[], month: string, today: Date): MoneyEntry[] {
  const todayStr = `${monthKey(today)}-${pad(today.getDate())}`;
  return templatesOf(entries).filter((t) => {
    if (t.date.slice(0, 7) >= month) return false;
    if (t.skipMonths?.includes(month)) return false;
    const date = recurringDay(t, month);
    const already = entries.some((e) => e.recurringFrom === t.id && e.date.startsWith(month));
    return !already && date > todayStr;
  });
}

// ── Export ───────────────────────────────────────────────────────────────────

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A month's rows as CSV, for a spreadsheet or an accountant. */
export function monthCsv(
  entries: MoneyEntry[],
  month: string,
  label: (e: MoneyEntry) => string,
): string {
  const rows = entries
    .filter((e) => e.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));
  const lines = [['date', 'type', 'description', 'category', 'amount'].join(',')];
  for (const e of rows) {
    lines.push(
      [
        e.date,
        e.kind,
        csvCell(e.description),
        csvCell(label(e)),
        e.kind === 'expense' ? -e.amount : e.amount,
      ].join(','),
    );
  }
  return lines.join('\n');
}
