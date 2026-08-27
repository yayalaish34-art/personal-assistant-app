import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  cancelAllReminders,
  cancelReminder,
  scheduleEventReminder,
  scheduleTaskReminder,
} from './notifications';

// Local-only data layer. Everything lives in AsyncStorage on the device —
// there is no server, no network, and no account.
//
// The method names and return shapes mirror the REST API this replaced, so the
// screens did not have to change how they call it. Reads that were `GET /x`
// are now a JSON parse; writes that were `POST /x` are a read-modify-write.
//
// Identity: a device-scoped uuid generated on first launch. It exists so rows
// have a stable owner if data is ever synced; nothing authenticates.

const KEYS = {
  tasks: '@pa/tasks',
  events: '@pa/events',
  notes: '@pa/notes',
  shopping: '@pa/shopping',
  money: '@pa/money',
  debts: '@pa/debts',
  chat: '@pa/chat',
  user: '@pa/user',
  seeded: '@pa/seeded',
} as const;

async function readList<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // Corrupt payload — start clean rather than failing every read.
    return [];
  }
}

async function writeList<T>(key: string, rows: T[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(rows));
}

/** Kept so screens can keep catching a typed error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Always false now: there is nothing to sign in to. */
  get isAuthError(): boolean {
    return false;
  }
}

// ── Types (unchanged from the shape the screens were written against) ──

export type User = {
  id: string;
  email: string;
  name: string;
  language: 'he' | 'en';
  timezone: string;
  createdAt?: string;
};

export type Task = {
  id: string;
  title: string;
  notes: string | null;
  startAt: string | null;
  dueAt: string | null;
  isDone: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Event = {
  id: string;
  title: string;
  note: string | null;
  /** Where it happens, as typed. Used to check a journey is possible. */
  location: string | null;
  startsAt: string;
  endsAt: string;
  reminderMinutesBefore: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** A filed note — free text with nothing to do and nothing to schedule. */
export type Note = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

// ── Shopping ────────────────────────────────────────────────────────────────

/** Aisles, roughly in the order a supermarket is walked. */
export const SHOPPING_CATEGORIES = [
  'produce',
  'dairy',
  'meat',
  'bakery',
  'cleaning',
  'pharmacy',
  'other',
] as const;

export type ShoppingCategory = (typeof SHOPPING_CATEGORIES)[number];

/** One line on the shopping list. Only `name` is ever required. */
export type ShoppingItem = {
  id: string;
  name: string;
  /** Free text — "2", "500g", "a couple" — because that is how people shop. */
  quantity: string | null;
  note: string | null;
  category: ShoppingCategory | null;
  isBought: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

// ── Money ───────────────────────────────────────────────────────────────────

export const INCOME_CATEGORIES = ['salary', 'business', 'refund', 'gift', 'other'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export const EXPENSE_CATEGORIES = [
  'shopping',
  'food',
  'housing',
  'bills',
  'transport',
  'health',
  'fun',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * Money in or money out. One row type rather than two tables: the fields are
 * identical, the sign is carried by `kind`, and every total on the screen is a
 * filter over the same list.
 */
export type MoneyEntry = {
  id: string;
  kind: 'income' | 'expense';
  description: string;
  /** Always positive. `kind` decides which way it counts. */
  amount: number;
  /** Local YYYY-MM-DD, matching how the rest of the app writes plain dates. */
  date: string;
  category: IncomeCategory | ExpenseCategory | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Money owed, in either direction, until it is settled. */
export type Debt = {
  id: string;
  /** 'owe' → I owe them. 'owed' → they owe me. */
  direction: 'owe' | 'owed';
  person: string;
  amount: number;
  description: string | null;
  date: string;
  isSettled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: unknown[] | null;
  toolCallId: string | null;
  pendingAction: { tool: string; arguments: Record<string, unknown> } | null;
  createdAt: string;
};

/** RFC-4122 v4 UUID. */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const nowIso = () => new Date().toISOString();

/** Device profile, created on first use. */
async function loadUser(): Promise<User> {
  const raw = await AsyncStorage.getItem(KEYS.user);
  if (raw) {
    try {
      return JSON.parse(raw) as User;
    } catch {
      /* fall through and recreate */
    }
  }
  const user: User = {
    id: uuid(),
    email: '',
    name: '',
    language: 'en',
    // Falls back to UTC on the rare platform without a resolved timezone.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    createdAt: nowIso(),
  };
  await AsyncStorage.setItem(KEYS.user, JSON.stringify(user));
  return user;
}

/** Local YYYY-MM-DD, matching how the screens format dates. */
function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const live = <T extends { deletedAt: string | null }>(rows: T[]) =>
  rows.filter((r) => r.deletedAt === null);

/**
 * Bumped whenever the sample set changes.
 *
 * The marker used to be a bare '1', so a device that had already launched
 * never saw a new set. Storing the version instead lets a changed sample reach
 * an install that is already running.
 */
const SEED_VERSION = '2';

/** Work and life, mixed the way a real month is. */
const TASK_POOL: [title: string, notes: string, hour: number][] = [
  ['Write the weekly update', '[Medium] Send before end of day', 17],
  ['Book flights for the offsite', '[High] Two travellers, direct', 12],
  ['Renew the SSL certificate', '[High] Expires this month', 10],
  ['Review the design handoff', '[Medium] Check spacing and states', 15],
  ['Pay the electricity bill', '[High] Before the late fee', 9],
  ['Call the accountant', '[Medium] Quarterly numbers', 11],
  ['Order a birthday present', '[Medium] Something she would use', 19],
  ['Refill the prescription', '[High] Two weeks left', 8],
  ['Clear the inbox', '[Low] Down to zero', 16],
  ['Draft the offsite agenda', '[Medium] Half a day, four topics', 14],
  ['Back up the laptop', '[Low] Overdue by a month', 21],
  ['Book the dentist follow-up', '[Medium] Six month check', 13],
  ['Update the CV', '[Low] Add the last two projects', 20],
  ['Water the plants', '[Low] The ones by the window', 18],
  ['Send the invoice', '[High] Net 30, chase if quiet', 10],
  ['Plan the weekend trip', '[Medium] Two nights, north', 20],
  ['Fix the leaking tap', '[Medium] Washer, not the whole unit', 17],
  ['Read the background job docs', '[Low] Retry semantics', 22],
  ['Renew the parking permit', '[High] Expires on the 28th', 9],
  ['Cancel the unused subscription', '[Low] The one from January', 16],
  ['Prepare the sprint demo', '[High] Five minutes, no slides', 15],
  ['Buy groceries', '[Medium] List is on the fridge', 18],
  ['Schedule the car service', '[Medium] Due at 60k', 11],
  ['Write the retro notes', '[Medium] Before it fades', 16],
  ['Return the parcel', '[Low] Wrong size', 13],
];

const EVENT_POOL: [title: string, note: string, hour: number, minute: number][] = [
  ['Daily standup', '[Medium] Blockers and hand-offs', 9, 0],
  ['Review pull requests', '[High] Clear the queue', 11, 0],
  ['Design review', '[Medium] Onboarding flow', 14, 0],
  ['Gym', '[Low] Upper body, 45 min', 18, 0],
  ['Stakeholder demo', '[High] Walkthrough, 40 min', 11, 30],
  ['Dentist appointment', '[Low] Cleaning', 16, 30],
  ['Sprint planning', '[High] Scope and capacity', 9, 30],
  ['One-on-one', '[Medium] Career, not status', 13, 0],
  ['Lunch with Sarah', '[Low] The place on the corner', 12, 30],
  ['Team retro', '[Medium] What to stop doing', 15, 30],
  ['Parents evening', '[High] Both teachers', 17, 0],
  ['Yoga class', '[Low] Bring the mat', 7, 30],
];

/**
 * Fills the current month with example rows, so the screens have something
 * with shape to them — a week that is already done, a today with work on it,
 * and a month ahead that is not empty.
 *
 * Rows are appended rather than written over: an install that has been used
 * keeps whatever was created on it. The marker is stored either way, so
 * deleting everything does not bring it back on the next launch.
 */
async function seedOnce(): Promise<void> {
  if ((await AsyncStorage.getItem(KEYS.seeded)) === SEED_VERSION) return;
  await AsyncStorage.setItem(KEYS.seeded, SEED_VERSION);

  const stamp = nowIso();
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayDate = today.getDate();

  /** A time on the given day of the current month. */
  const on = (day: number, h: number, m = 0) =>
    new Date(year, month, day, h, m, 0, 0).toISOString();

  const tasks: Task[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    // Today carries a full plate; every other day one or two things.
    const count = day === todayDate ? 4 : ((day % 3) === 0 ? 2 : 1);
    for (let k = 0; k < count; k++) {
      const [title, notes, hour] = TASK_POOL[(day * 2 + k) % TASK_POOL.length];
      tasks.push({
        id: uuid(),
        title,
        notes,
        startAt: null,
        dueAt: on(day, hour),
        // What is behind us is mostly done, and part of today is too — a day
        // with nothing ticked off leaves the completion card and the
        // productivity line both reading zero, which says nothing at all.
        isDone:
          day < todayDate ? (day + k) % 5 !== 0 : day === todayDate ? k < 2 : false,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      });
    }
  }

  // A couple with no date at all: the list has to handle them.
  for (const [title, notes] of [
    ['Read the docs', '[Low] Background job patterns'],
    ['Tidy the photo library', '[Low] Whenever there is a gap'],
  ]) {
    tasks.push({
      id: uuid(),
      title,
      notes,
      startAt: null,
      dueAt: null,
      isDone: false,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
    });
  }

  const events: Event[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(year, month, day).getDay();
    if (weekday === 6) continue; // Saturday stays clear
    const count = day === todayDate ? 4 : ((day % 2) === 0 ? 2 : 1);
    for (let k = 0; k < count; k++) {
      const [title, note, hour, minute] = EVENT_POOL[(day * 3 + k) % EVENT_POOL.length];
      events.push({
        id: uuid(),
        title,
        note,
        location: null,
        startsAt: on(day, hour, minute),
        endsAt: on(day, hour + 1, minute),
        reminderMinutesBefore: 15,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      });
    }
  }

  const [haveEvents, haveTasks] = await Promise.all([
    readList<Event>(KEYS.events),
    readList<Task>(KEYS.tasks),
  ]);

  await Promise.all([
    writeList(KEYS.events, [...haveEvents, ...events]),
    writeList(KEYS.tasks, [...haveTasks, ...tasks]),
  ]);
}

export const api = {
  // ── Health: nothing to reach, so this always succeeds ──
  health: async () => ({ status: 'ok' }),

  // ── User ──
  getMe: async () => ({ user: await loadUser() }),
  updateMe: async (patch: Partial<Pick<User, 'name' | 'language' | 'timezone'>>) => {
    const user = { ...(await loadUser()), ...patch };
    await AsyncStorage.setItem(KEYS.user, JSON.stringify(user));
    return { user };
  },

  // ── Tasks ──
  listTasks: async () => ({
    tasks: (await seedOnce(), await readList<Task>(KEYS.tasks)),
    serverTime: nowIso(),
  }),

  createTask: async (t: {
    id: string;
    title: string;
    notes?: string;
    startAt?: string;
    dueAt?: string;
    updatedAt: string;
  }) => {
    const rows = await readList<Task>(KEYS.tasks);
    // Same id twice is a no-op, keeping the old create-is-idempotent rule.
    const existing = rows.find((r) => r.id === t.id);
    if (existing) return existing;

    const task: Task = {
      id: t.id,
      title: t.title,
      notes: t.notes ?? null,
      startAt: t.startAt ?? null,
      dueAt: t.dueAt ?? null,
      isDone: false,
      createdAt: nowIso(),
      updatedAt: t.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.tasks, [task, ...rows]);
    // Reminders are scheduled here rather than in the screens, so a task the
    // assistant creates rings exactly like one typed into the form.
    void scheduleTaskReminder(task);
    return task;
  },

  updateTask: async (
    id: string,
    patch: Partial<Pick<Task, 'title' | 'notes' | 'startAt' | 'dueAt' | 'isDone'>> & {
      updatedAt?: string;
    },
  ) => {
    const rows = await readList<Task>(KEYS.tasks);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Task not found');
    rows[i] = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    await writeList(KEYS.tasks, rows);
    // Moving the due date moves the reminder; completing it drops the reminder.
    void scheduleTaskReminder(rows[i]);
    return rows[i];
  },

  deleteTask: async (id: string) => {
    const rows = await readList<Task>(KEYS.tasks);
    // Hard delete: there is no sync partner that needs to see a tombstone.
    await writeList(
      KEYS.tasks,
      rows.filter((r) => r.id !== id),
    );
    void cancelReminder(id);
  },

  // ── Events ──
  listEvents: async () => ({
    events: (await seedOnce(), await readList<Event>(KEYS.events)),
    serverTime: nowIso(),
  }),

  createEvent: async (e: {
    id: string;
    title: string;
    note?: string;
    location?: string;
    startsAt: string;
    endsAt?: string;
    reminderMinutesBefore?: number | null;
    updatedAt: string;
  }) => {
    const rows = await readList<Event>(KEYS.events);
    const existing = rows.find((r) => r.id === e.id);
    if (existing) return existing;

    const event: Event = {
      id: e.id,
      title: e.title,
      note: e.note ?? null,
      location: e.location ?? null,
      startsAt: e.startsAt,
      // Default duration matches what the old backend applied.
      endsAt:
        e.endsAt ??
        new Date(new Date(e.startsAt).getTime() + 60 * 60 * 1000).toISOString(),
      reminderMinutesBefore: e.reminderMinutesBefore ?? null,
      createdAt: nowIso(),
      updatedAt: e.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.events, [event, ...rows]);
    void scheduleEventReminder(event);
    return event;
  },

  updateEvent: async (
    id: string,
    patch: Partial<
      Pick<Event, 'title' | 'note' | 'location' | 'startsAt' | 'endsAt' | 'reminderMinutesBefore'>
    > & { updatedAt?: string },
  ) => {
    const rows = await readList<Event>(KEYS.events);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Event not found');
    rows[i] = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    await writeList(KEYS.events, rows);
    void scheduleEventReminder(rows[i]);
    return rows[i];
  },

  deleteEvent: async (id: string) => {
    const rows = await readList<Event>(KEYS.events);
    await writeList(
      KEYS.events,
      rows.filter((r) => r.id !== id),
    );
    void cancelReminder(id);
  },

  // ── Notes ──
  listNotes: async () => ({
    notes: live(await readList<Note>(KEYS.notes)),
  }),

  createNote: async (n: { id: string; text: string; updatedAt: string }) => {
    const rows = await readList<Note>(KEYS.notes);
    // Same id twice is a no-op, keeping the old create-is-idempotent rule.
    const existing = rows.find((r) => r.id === n.id);
    if (existing) return existing;

    const note: Note = {
      id: n.id,
      text: n.text,
      createdAt: nowIso(),
      updatedAt: n.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.notes, [note, ...rows]);
    return note;
  },

  deleteNote: async (id: string) => {
    const rows = await readList<Note>(KEYS.notes);
    await writeList(
      KEYS.notes,
      rows.filter((r) => r.id !== id),
    );
  },

  // ── Shopping list ──
  listShopping: async () => ({
    items: live(await readList<ShoppingItem>(KEYS.shopping)),
  }),

  createShoppingItem: async (i: {
    id: string;
    name: string;
    quantity?: string | null;
    note?: string | null;
    category?: ShoppingCategory | null;
    updatedAt: string;
  }) => {
    const rows = await readList<ShoppingItem>(KEYS.shopping);
    // Same id twice is a no-op, keeping the old create-is-idempotent rule.
    const existing = rows.find((r) => r.id === i.id);
    if (existing) return existing;

    const item: ShoppingItem = {
      id: i.id,
      name: i.name,
      quantity: i.quantity ?? null,
      note: i.note ?? null,
      category: i.category ?? null,
      isBought: false,
      createdAt: nowIso(),
      updatedAt: i.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.shopping, [item, ...rows]);
    return item;
  },

  updateShoppingItem: async (
    id: string,
    patch: Partial<Pick<ShoppingItem, 'name' | 'quantity' | 'note' | 'category' | 'isBought'>> & {
      updatedAt?: string;
    },
  ) => {
    const rows = await readList<ShoppingItem>(KEYS.shopping);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Item not found');
    rows[i] = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    await writeList(KEYS.shopping, rows);
    return rows[i];
  },

  deleteShoppingItem: async (id: string) => {
    const rows = await readList<ShoppingItem>(KEYS.shopping);
    await writeList(
      KEYS.shopping,
      rows.filter((r) => r.id !== id),
    );
  },

  /** Clears the trolley: everything already ticked off, in one go. */
  clearBoughtShopping: async () => {
    const rows = await readList<ShoppingItem>(KEYS.shopping);
    await writeList(
      KEYS.shopping,
      rows.filter((r) => !r.isBought),
    );
  },

  // ── Money: income and expenses ──
  listMoney: async () => ({
    entries: live(await readList<MoneyEntry>(KEYS.money)),
  }),

  createMoneyEntry: async (e: {
    id: string;
    kind: 'income' | 'expense';
    description: string;
    amount: number;
    date: string;
    category?: IncomeCategory | ExpenseCategory | null;
    updatedAt: string;
  }) => {
    const rows = await readList<MoneyEntry>(KEYS.money);
    const existing = rows.find((r) => r.id === e.id);
    if (existing) return existing;

    const entry: MoneyEntry = {
      id: e.id,
      kind: e.kind,
      description: e.description,
      // Stored positive whatever arrives: `kind` is what carries the sign, and
      // a negative expense would subtract twice on the summary.
      amount: Math.abs(e.amount),
      date: e.date,
      category: e.category ?? null,
      createdAt: nowIso(),
      updatedAt: e.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.money, [entry, ...rows]);
    return entry;
  },

  updateMoneyEntry: async (
    id: string,
    patch: Partial<Pick<MoneyEntry, 'description' | 'amount' | 'date' | 'category' | 'kind'>> & {
      updatedAt?: string;
    },
  ) => {
    const rows = await readList<MoneyEntry>(KEYS.money);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Entry not found');
    const next = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    if (patch.amount !== undefined) next.amount = Math.abs(patch.amount);
    rows[i] = next;
    await writeList(KEYS.money, rows);
    return rows[i];
  },

  deleteMoneyEntry: async (id: string) => {
    const rows = await readList<MoneyEntry>(KEYS.money);
    await writeList(
      KEYS.money,
      rows.filter((r) => r.id !== id),
    );
  },

  // ── Debts ──
  listDebts: async () => ({
    debts: live(await readList<Debt>(KEYS.debts)),
  }),

  createDebt: async (d: {
    id: string;
    direction: 'owe' | 'owed';
    person: string;
    amount: number;
    description?: string | null;
    date: string;
    updatedAt: string;
  }) => {
    const rows = await readList<Debt>(KEYS.debts);
    const existing = rows.find((r) => r.id === d.id);
    if (existing) return existing;

    const debt: Debt = {
      id: d.id,
      direction: d.direction,
      person: d.person,
      amount: Math.abs(d.amount),
      description: d.description ?? null,
      date: d.date,
      isSettled: false,
      createdAt: nowIso(),
      updatedAt: d.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.debts, [debt, ...rows]);
    return debt;
  },

  updateDebt: async (
    id: string,
    patch: Partial<
      Pick<Debt, 'direction' | 'person' | 'amount' | 'description' | 'date' | 'isSettled'>
    > & { updatedAt?: string },
  ) => {
    const rows = await readList<Debt>(KEYS.debts);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Debt not found');
    const next = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    if (patch.amount !== undefined) next.amount = Math.abs(patch.amount);
    rows[i] = next;
    await writeList(KEYS.debts, rows);
    return rows[i];
  },

  deleteDebt: async (id: string) => {
    const rows = await readList<Debt>(KEYS.debts);
    await writeList(
      KEYS.debts,
      rows.filter((r) => r.id !== id),
    );
  },

  // ── Agenda: events and tasks for a day or range, in local time ──
  agendaForDate: async (date: string) => {
    await seedOnce();
    const [events, tasks] = await Promise.all([
      readList<Event>(KEYS.events),
      readList<Task>(KEYS.tasks),
    ]);
    return {
      events: live(events).filter((e) => localDay(e.startsAt) === date),
      tasks: live(tasks).filter((t) => t.dueAt && localDay(t.dueAt) === date),
    };
  },

  agendaForRange: async (from: string, to: string) => {
    const [events, tasks] = await Promise.all([
      readList<Event>(KEYS.events),
      readList<Task>(KEYS.tasks),
    ]);
    const within = (day: string) => day >= from && day <= to;
    return {
      events: live(events).filter((e) => within(localDay(e.startsAt))),
      tasks: live(tasks).filter((t) => t.dueAt && within(localDay(t.dueAt))),
    };
  },

  // ── Chat history (local; reply logic lives in lib/assistant.ts) ──
  chatHistory: async () => ({
    messages: await readList<ChatMessage>(KEYS.chat),
    nextCursor: null as string | null,
  }),

  appendChat: async (messages: ChatMessage[]) => {
    const rows = await readList<ChatMessage>(KEYS.chat);
    await writeList(KEYS.chat, [...rows, ...messages]);
  },

  clearChat: async () => {
    await AsyncStorage.removeItem(KEYS.chat);
  },

  /** Wipes every stored row. Used by "Clear all data" in Profile. */
  clearAll: async () => {
    await AsyncStorage.multiRemove([
      KEYS.tasks,
      KEYS.events,
      KEYS.notes,
      KEYS.shopping,
      KEYS.money,
      KEYS.debts,
      KEYS.chat,
    ]);
    // Rows are gone, so their alarms must go with them.
    await cancelAllReminders();
  },
};
