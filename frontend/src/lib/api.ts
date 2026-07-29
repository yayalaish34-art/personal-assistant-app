import AsyncStorage from '@react-native-async-storage/async-storage';

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
  startsAt: string;
  endsAt: string;
  reminderMinutesBefore: number | null;
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
 * Puts a small set of example rows in place on first launch, so the app has
 * something to show instead of four empty screens. Runs once — the marker is
 * written whether or not rows were added, so a user who deletes everything
 * doesn't get it back on the next launch.
 */
async function seedOnce(): Promise<void> {
  if (await AsyncStorage.getItem(KEYS.seeded)) return;
  await AsyncStorage.setItem(KEYS.seeded, '1');

  const at = (dayOffset: number, h: number, m = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const stamp = nowIso();

  const events: Event[] = [
    ['Daily standup', '[Medium] Blockers and hand-offs', 0, 9],
    ['Review pull requests', '[High] Clear the queue', 0, 11],
    ['Design review', '[Medium] Onboarding flow', 0, 14],
    ['Gym', '[Low] Upper body, 45 min', 0, 18],
    ['Stakeholder demo', '[High] Walkthrough, 40 min', 1, 11],
    ['Dentist appointment', '[Low] Cleaning', 2, 16, 30],
    ['Sprint planning', '[High] Scope and capacity', 3, 9, 30],
  ].map(([title, note, d, h, m]) => ({
    id: uuid(),
    title: title as string,
    note: note as string,
    startsAt: at(d as number, h as number, (m as number) ?? 0),
    endsAt: at(d as number, (h as number) + 1, (m as number) ?? 0),
    reminderMinutesBefore: 15,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
  }));

  const tasks: Task[] = [
    ['Write the weekly update', '[Medium] Send before end of day', 0, 17],
    ['Book flights for the offsite', '[High] Two travellers, direct', 1, 12],
    ['Renew the SSL certificate', '[High] Expires soon', 2, 10],
    ['Read the docs', '[Low] Background job patterns', null, 0],
  ].map(([title, notes, d, h]) => ({
    id: uuid(),
    title: title as string,
    notes: notes as string,
    dueAt: d === null ? null : at(d as number, h as number),
    isDone: false,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
  }));

  await Promise.all([writeList(KEYS.events, events), writeList(KEYS.tasks, tasks)]);
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
      dueAt: t.dueAt ?? null,
      isDone: false,
      createdAt: nowIso(),
      updatedAt: t.updatedAt,
      deletedAt: null,
    };
    await writeList(KEYS.tasks, [task, ...rows]);
    return task;
  },

  updateTask: async (
    id: string,
    patch: Partial<Pick<Task, 'title' | 'notes' | 'dueAt' | 'isDone'>> & {
      updatedAt?: string;
    },
  ) => {
    const rows = await readList<Task>(KEYS.tasks);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Task not found');
    rows[i] = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    await writeList(KEYS.tasks, rows);
    return rows[i];
  },

  deleteTask: async (id: string) => {
    const rows = await readList<Task>(KEYS.tasks);
    // Hard delete: there is no sync partner that needs to see a tombstone.
    await writeList(
      KEYS.tasks,
      rows.filter((r) => r.id !== id),
    );
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
    return event;
  },

  updateEvent: async (
    id: string,
    patch: Partial<
      Pick<Event, 'title' | 'note' | 'startsAt' | 'endsAt' | 'reminderMinutesBefore'>
    > & { updatedAt?: string },
  ) => {
    const rows = await readList<Event>(KEYS.events);
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new ApiError(404, 'NOT_FOUND', 'Event not found');
    rows[i] = { ...rows[i], ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    await writeList(KEYS.events, rows);
    return rows[i];
  },

  deleteEvent: async (id: string) => {
    const rows = await readList<Event>(KEYS.events);
    await writeList(
      KEYS.events,
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
    await AsyncStorage.multiRemove([KEYS.tasks, KEYS.events, KEYS.chat]);
  },
};
