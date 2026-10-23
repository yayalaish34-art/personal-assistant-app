import type { Event, MoneyEntry, ShoppingItem, Task, ExpenseCategory } from './api';
import type { ShoppingHistory } from './shopping';

// Everything the "Full statistics" screen shows — one library, three domains
// (finance, calendar, shopping), each with the same shape: a time range on top,
// a headline number under it, and a list of parts adding up to the whole.
//
// A range is a plain window over local dates. The domain helpers take the raw
// rows, keep the ones inside the window, and return numbers, category splits
// and per-bucket series a chart can walk without arithmetic of its own.

// ── Time range ──────────────────────────────────────────────────────────────

/** The six windows the reader can pick between. */
export type Range = 'day' | 'week' | 'month' | 'half' | 'year' | 'all';

export const RANGES: Range[] = ['day', 'week', 'month', 'half', 'year', 'all'];

export type Window = {
  /** Local YYYY-MM-DD, inclusive. */
  from: string;
  /** Local YYYY-MM-DD, inclusive. */
  to: string;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Local YYYY-MM-DD from a Date. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The window a range covers, ending today. "All" uses a wide floor rather
 * than a real minimum, so every row the user could have entered is inside.
 */
export function windowOf(range: Range, today: Date = new Date()): Window {
  const to = ymd(today);
  if (range === 'all') return { from: '0000-01-01', to };
  const start = new Date(today);
  if (range === 'day') {
    return { from: to, to };
  }
  if (range === 'week') {
    start.setDate(start.getDate() - 6);
  } else if (range === 'month') {
    start.setDate(start.getDate() - 29);
  } else if (range === 'half') {
    start.setMonth(start.getMonth() - 6);
    start.setDate(start.getDate() + 1);
  } else if (range === 'year') {
    start.setFullYear(start.getFullYear() - 1);
    start.setDate(start.getDate() + 1);
  }
  return { from: ymd(start), to };
}

/** How many days the window covers, inclusive. */
export function daysIn(w: Window): number {
  const [ay, am, ad] = w.from.split('-').map(Number);
  const [by, bm, bd] = w.to.split('-').map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** True if a YYYY-MM-DD sits inside the window (both ends inclusive). */
export function inWindow(day: string, w: Window): boolean {
  return day >= w.from && day <= w.to;
}

// ── Bucketing ───────────────────────────────────────────────────────────────

/** One column on a small series chart: a label and its value. */
export type Bucket = { key: string; label: string; value: number };

/**
 * How the range is chopped up for the mini chart on the summary card. A short
 * range gets days; a long one gets months.
 */
export function bucketsFor(range: Range): 'day' | 'month' {
  return range === 'day' || range === 'week' || range === 'month' ? 'day' : 'month';
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Adds a value into the map at `key`, creating a zero entry first if needed.
 * Kept as one line so the domain code below reads as arithmetic rather than
 * map-plumbing.
 */
function add<K>(m: Map<K, number>, key: K, value: number): void {
  m.set(key, (m.get(key) ?? 0) + value);
}

/** Turns a Map into a Bucket list, largest first, dropping zeroes. */
function mapToBuckets<K extends string>(
  m: Map<K, number>,
  label: (key: K) => string,
): Bucket[] {
  return [...m.entries()]
    .filter(([, v]) => v > 0)
    .map(([k, value]) => ({ key: k, label: label(k), value }))
    .sort((a, b) => b.value - a.value);
}

// ── Finance stats ───────────────────────────────────────────────────────────

export type FinanceStats = {
  income: number;
  expenses: number;
  balance: number;
  /** Median day's spend, in the window's smallest currency unit. */
  dailyAverage: number;
  /** Share of income the reader kept, 0–1. Zero when income is zero. */
  savingsRate: number;
  /** Number of transactions in the window. */
  count: number;
  /** Split of expenses by category, largest first. */
  byCategory: Bucket[];
  /** Split of income by source, largest first. */
  byIncome: Bucket[];
  /** Series across the window's buckets, in order. */
  series: Bucket[];
};

/**
 * All the money numbers for one window.
 *
 * `catLabel` and `incLabel` are passed in so the stats module stays free of
 * translation strings — the screen renders headings in the reader's language.
 */
export function financeStats(
  entries: MoneyEntry[],
  w: Window,
  catLabel: (c: ExpenseCategory | 'none') => string,
  incLabel: (c: string) => string,
  localeTag = 'en-US',
): FinanceStats {
  let income = 0;
  let expenses = 0;
  let count = 0;
  const cats = new Map<ExpenseCategory | 'none', number>();
  const incs = new Map<string, number>();

  for (const e of entries) {
    if (!inWindow(e.date, w)) continue;
    count += 1;
    if (e.kind === 'income') {
      income += e.amount;
      add(incs, e.category ?? 'other', e.amount);
    } else {
      expenses += e.amount;
      add(cats, (e.category as ExpenseCategory | null) ?? 'none', e.amount);
    }
  }

  const days = Math.max(1, daysIn(w));
  const series = buildSeries(w, entries, (e) => (e.kind === 'expense' ? e.amount : 0), localeTag);

  return {
    income,
    expenses,
    balance: income - expenses,
    dailyAverage: Math.round(expenses / days),
    savingsRate: income > 0 ? Math.max(0, (income - expenses) / income) : 0,
    count,
    byCategory: mapToBuckets(cats, catLabel),
    byIncome: mapToBuckets(incs, incLabel),
    series,
  };
}

/**
 * Series across the window: one bar per day for short ranges, one per month
 * for the longer ones. The bar for a period the reader has not reached yet is
 * held at zero — a chart with a straight line to the end reads as boredom
 * rather than as no data.
 */
function buildSeries(
  w: Window,
  entries: MoneyEntry[],
  value: (e: MoneyEntry) => number,
  localeTag: string,
): Bucket[] {
  const mode: 'day' | 'month' = daysIn(w) <= 62 ? 'day' : 'month';
  const [fy, fm, fd] = w.from.split('-').map(Number);
  const [ty, tm, td] = w.to.split('-').map(Number);
  const start = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);

  const buckets = new Map<string, number>();
  const order: string[] = [];

  if (mode === 'day') {
    const cur = new Date(start);
    while (cur <= end) {
      const key = ymd(cur);
      buckets.set(key, 0);
      order.push(key);
      cur.setDate(cur.getDate() + 1);
    }
    for (const e of entries) {
      if (!inWindow(e.date, w)) continue;
      const v = value(e);
      if (v > 0 && buckets.has(e.date)) buckets.set(e.date, (buckets.get(e.date) ?? 0) + v);
    }
    return order.map((key) => ({
      key,
      label: shortDayLabel(key),
      value: buckets.get(key) ?? 0,
    }));
  }

  // Monthly buckets, first day of the month as the key.
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const stop = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= stop) {
    const key = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`;
    buckets.set(key, 0);
    order.push(key);
    cur.setMonth(cur.getMonth() + 1);
  }
  for (const e of entries) {
    if (!inWindow(e.date, w)) continue;
    const v = value(e);
    if (v <= 0) continue;
    const key = e.date.slice(0, 7);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + v);
  }
  return order.map((key) => ({ key, label: shortMonthLabel(key, localeTag), value: buckets.get(key) ?? 0 }));
}

function shortDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d}/${m}`;
}

function shortMonthLabel(month: string, localeTag: string): string {
  const [, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(localeTag, { month: 'short' }).format(new Date(2000, m - 1, 1));
}

// ── Calendar stats ──────────────────────────────────────────────────────────

/**
 * Buckets an event falls into by the words in its title. A single event can
 * only belong to one, so the totals add up cleanly to the hours logged.
 * Order matters: the first bucket to match wins, so more specific patterns are
 * declared before more general ones.
 */
const EVENT_CATEGORIES: { key: string; test: RegExp }[] = [
  {
    key: 'gym',
    test: /gym|workout|run|training|yoga|pilates|swim|כושר|אימון|ריצה|יוגה/i,
  },
  {
    key: 'meeting',
    test: /meeting|sync|standup|call|1:1|1-1|interview|פגישה|סטנדאפ|שיחה|ראיון/i,
  },
  { key: 'work', test: /work|office|shift|deadline|project|עבודה|משמרת|פרויקט/i },
  {
    key: 'fun',
    test: /party|drinks|movie|dinner|lunch|coffee|date|show|בילוי|מסיבה|סרט|ארוחה|קפה/i,
  },
  { key: 'family', test: /family|kids|parents|mom|dad|משפחה|ילדים|אמא|אבא/i },
  { key: 'study', test: /study|class|lesson|exam|homework|לימודים|שיעור|מבחן/i },
  { key: 'health', test: /doctor|dentist|clinic|therapy|checkup|רופא|שיניים|קליניקה/i },
  { key: 'errand', test: /errand|pickup|drop\s?off|shopping|סידור|קניות|איסוף/i },
  { key: 'travel', test: /flight|train|drive|commute|travel|טיסה|נסיעה|רכבת/i },
];

export type CalendarStats = {
  /** Number of events inside the window. */
  eventCount: number;
  /** Number of tasks (any status) inside the window. */
  taskCount: number;
  /** Tasks finished inside the window. */
  tasksDone: number;
  /** Share of the window's tasks that were finished, 0–1. */
  completionRate: number;
  /** Total hours booked by events inside the window. */
  hoursBusy: number;
  /** Average hours per active day (days with at least one event). */
  avgPerDay: number;
  /** Longest run of consecutive days with at least one event finished. */
  streak: number;
  /** Split of hours by event category, largest first. */
  byCategory: Bucket[];
  /** Hours per weekday, Sun→Sat. */
  byWeekday: Bucket[];
  /** Hours per hour of the day (24). */
  byHour: Bucket[];
};

/** Which bucket a title lands in, or "other" if nothing matches. */
export function classifyEvent(title: string): string {
  for (const c of EVENT_CATEGORIES) if (c.test.test(title)) return c.key;
  return 'other';
}

export function calendarStats(
  events: Event[],
  tasks: Task[],
  w: Window,
  catLabel: (c: string) => string,
  weekdayLabel: (i: number) => string,
): CalendarStats {
  const cats = new Map<string, number>();
  const weekdays = new Map<number, number>();
  const hours = new Map<number, number>();
  let hoursBusy = 0;
  let eventCount = 0;
  const busyDays = new Set<string>();
  const windowStart = new Date(`${w.from}T00:00:00`).getTime();
  const lastDay = new Date(`${w.to}T00:00:00`);
  lastDay.setDate(lastDay.getDate() + 1);
  const windowEnd = lastDay.getTime();
  const boundaries: { time: number; category: string; delta: number }[] = [];
  for (const e of events) {
    if (e.deletedAt) continue;
    const start = Math.max(windowStart, new Date(e.startsAt).getTime());
    const end = Math.min(windowEnd, new Date(e.endsAt).getTime());
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    eventCount += 1;
    const category = classifyEvent(e.title);
    boundaries.push({ time: start, category, delta: 1 }, { time: end, category, delta: -1 });
  }

  // Count overlapping time once; concurrent events share it equally.
  boundaries.sort((a, b) => a.time - b.time);
  const active = new Map<string, number>();
  let activeCount = 0;
  for (let i = 0; i < boundaries.length; i += 1) {
    const boundary = boundaries[i];
    add(active, boundary.category, boundary.delta);
    activeCount += boundary.delta;
    const next = boundaries[i + 1]?.time;
    if (next === undefined || next <= boundary.time || activeCount === 0) continue;
    const duration = (next - boundary.time) / 3_600_000;
    hoursBusy += duration;
    for (const [category, count] of active) {
      if (count > 0) add(cats, category, duration * count / activeCount);
    }
    // Split events across the hours and days actually occupied.
    let cursor = boundary.time;
    while (cursor < next) {
      const date = new Date(cursor);
      const nextHour = new Date(cursor);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      const stop = Math.min(next, nextHour.getTime());
      const h = (stop - cursor) / 3_600_000;
      busyDays.add(ymd(date));
      add(weekdays, date.getDay(), h);
      add(hours, date.getHours(), h);
      cursor = stop;
    }
  }

  let taskCount = 0;
  let tasksDone = 0;
  const doneDays = new Set<string>();
  for (const t of tasks) {
    if (t.deletedAt) continue;
    const anchorIso = t.dueAt ?? t.startAt ?? t.createdAt;
    const day = ymd(new Date(anchorIso));
    if (!inWindow(day, w)) continue;
    taskCount += 1;
    if (t.isDone) {
      tasksDone += 1;
      doneDays.add(day);
    }
  }

  const activeDays = busyDays.size;
  return {
    eventCount,
    taskCount,
    tasksDone,
    completionRate: taskCount > 0 ? tasksDone / taskCount : 0,
    hoursBusy,
    avgPerDay: activeDays > 0 ? Math.round((hoursBusy / activeDays) * 10) / 10 : 0,
    streak: longestStreak(doneDays),
    byCategory: mapToBuckets(cats, catLabel),
    byWeekday: [...Array(7)]
      .map((_, i) => ({ key: String(i), label: weekdayLabel(i), value: weekdays.get(i) ?? 0 }))
      .filter((b) => b.value > 0),
    byHour: [...Array(24)]
      .map((_, i) => ({ key: String(i), label: `${i}:00`, value: hours.get(i) ?? 0 }))
      .filter((b) => b.value > 0),
  };
}

/** Longest run of consecutive YYYY-MM-DD in the set. */
function longestStreak(days: Set<string>): number {
  if (days.size === 0) return 0;
  const sorted = [...days].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const [ay, am, ad] = sorted[i - 1].split('-').map(Number);
    const [by, bm, bd] = sorted[i].split('-').map(Number);
    const prev = new Date(ay, am - 1, ad);
    const cur = new Date(by, bm - 1, bd);
    const gap = Math.round((cur.getTime() - prev.getTime()) / 86_400_000);
    if (gap === 1) run += 1;
    else run = 1;
    if (run > best) best = run;
  }
  return best;
}

// ── Shopping stats ──────────────────────────────────────────────────────────

export type ShoppingStats = {
  /** Items ticked off inside the window. */
  bought: number;
  /** Items still on the list (open) inside the window. */
  open: number;
  /** Rows added (bought + open) inside the window. */
  total: number;
  /** Estimated money spent this window (bought rows), if a factor is given. */
  spent: number;
  /** Items bought per day on average, over the window's days. */
  perDay: number;
  /** Split of bought items by aisle, largest first. */
  byCategory: Bucket[];
  /** Split of items by aisle overall, largest first. */
  byCategoryTotal: Bucket[];
  /** Items appearing most often across the window, largest first. */
  topItems: Bucket[];
};

/**
 * Shopping totals for a window. Prices come from an estimator the screen
 * passes in — the stats module does not know the currency or how the shop
 * prices things.
 *
 * `history` is the record of every tick over the life of the app (things
 * bought before then swept from the trolley at checkout). The current `items`
 * list only holds what is on the fridge now, so a "year" range that ignored
 * history would look empty on any device that shops.
 */
export function shoppingStats(
  items: ShoppingItem[],
  history: ShoppingHistory,
  w: Window,
  catLabel: (c: string) => string,
  estimate: (item: ShoppingItem) => number,
): ShoppingStats {
  let bought = 0;
  let open = 0;
  let spent = 0;
  const boughtCats = new Map<string, number>();
  const totalCats = new Map<string, number>();
  const names = new Map<string, number>();

  // Current list: still on the fridge, ticked or not.
  for (const item of items) {
    if (item.deletedAt) continue;
    const anchor = item.updatedAt ?? item.createdAt;
    const day = ymd(new Date(anchor));
    if (!inWindow(day, w)) continue;
    add(totalCats, item.category ?? 'other', 1);
    add(names, item.name.trim().toLowerCase() || '—', 1);
    if (item.isBought) {
      bought += 1;
      spent += estimate(item);
      add(boughtCats, item.category ?? 'other', 1);
    } else {
      open += 1;
    }
  }

  // History: past ticks whose rows are long gone. Each stamp inside the window
  // counts as a bought row of its own, priced against the aisle so the "spent"
  // figure isn't zero on a range that only sees history.
  for (const entry of Object.values(history)) {
    const cat = entry.category ?? 'other';
    const nameKey = entry.name.trim().toLowerCase() || '—';
    for (const stamp of entry.times) {
      const day = ymd(new Date(stamp));
      if (!inWindow(day, w)) continue;
      bought += 1;
      add(names, nameKey, 1);
      add(boughtCats, cat, 1);
      add(totalCats, cat, 1);
      spent += estimate({
        id: '',
        name: entry.name,
        quantity: null,
        note: null,
        category: entry.category,
        isBought: true,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      });
    }
  }

  const days = Math.max(1, daysIn(w));
  const topItems: Bucket[] = [...names.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, value]) => ({ key: k, label: k, value }));

  return {
    bought,
    open,
    total: bought + open,
    spent: Math.round(spent),
    perDay: Math.round((bought / days) * 10) / 10,
    byCategory: mapToBuckets(boughtCats, catLabel),
    byCategoryTotal: mapToBuckets(totalCats, catLabel),
    topItems,
  };
}

/**
 * A tiny helper for turning a share into "31%" — the stats module never
 * decides the reader's locale, so it never formats numbers on its own; this
 * is a one-liner the screen keeps calling.
 */
export function pctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

// ── Export ──────────────────────────────────────────────────────────────────

/** The three shapes the reader can share stats in. */
export type ExportFormat = 'csv' | 'json' | 'text';

/**
 * One row that shows up in the table (or list, or blob) the reader shares.
 * `section` groups rows into headings so the CSV reads like the on-screen
 * cards; `share` (0–1) is added when a value has a natural whole to compare
 * against, so the CSV can carry the same percentages the bars do.
 */
export type ExportRow = {
  section: string;
  label: string;
  value: string;
  share?: number;
};

/**
 * A file's worth of stats: what the sheet is called, the header line at the
 * top, and the rows that follow. Domains build one of these and hand it to
 * the format helpers below.
 */
export type ExportSheet = {
  title: string;
  header: string[];
  rows: ExportRow[];
};

const CSV_HEADER = ['Section', 'Label', 'Value', 'Share %'];

function escapeCsv(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** RFC-4180ish CSV: comma-separated, quoted where needed, CRLF between rows. */
export function toCsv(sheet: ExportSheet): string {
  const head = (sheet.header.length ? sheet.header : CSV_HEADER).map(escapeCsv).join(',');
  const rows = sheet.rows.map((r) =>
    [
      escapeCsv(r.section),
      escapeCsv(r.label),
      escapeCsv(r.value),
      r.share !== undefined ? String(Math.round(r.share * 100)) : '',
    ].join(','),
  );
  return [head, ...rows].join('\r\n');
}

/** Grouped by section, then indented lines — for the plain-text sharer. */
export function toText(sheet: ExportSheet): string {
  const groups = new Map<string, ExportRow[]>();
  for (const r of sheet.rows) {
    const list = groups.get(r.section);
    if (list) list.push(r);
    else groups.set(r.section, [r]);
  }
  const parts: string[] = [sheet.title, '='.repeat(sheet.title.length), ''];
  for (const [section, rows] of groups) {
    parts.push(section);
    parts.push('-'.repeat(section.length));
    for (const r of rows) {
      const pct = r.share !== undefined ? `  (${Math.round(r.share * 100)}%)` : '';
      parts.push(`  ${r.label}: ${r.value}${pct}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

/** Straight JSON: title, generated-at, and the rows verbatim. */
export function toJson(sheet: ExportSheet): string {
  return JSON.stringify(
    {
      title: sheet.title,
      generatedAt: new Date().toISOString(),
      header: sheet.header,
      rows: sheet.rows,
    },
    null,
    2,
  );
}

/** File name for a shared export, without the extension. */
export function exportBasename(kind: string, range: Range): string {
  const stamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16);
  return `${kind}-stats-${range}-${stamp}`;
}
