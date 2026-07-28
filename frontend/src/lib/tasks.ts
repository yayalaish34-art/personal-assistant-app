import type { Priority } from '../theme';
import type { Event, Task } from './api';

// Task helpers shared by the Today / Calendar / Add Task screens.
//
// The backend stores events as UTC instants (`startsAt`/`endsAt`) while the UI
// works in local date + time strings, so the helpers here are the single
// bridge between the two. Priority has no column in the backend schema, so it
// stays encoded as a "[High] " prefix inside the free-text note field.
const PR_RE = /^\[(Low|Medium|High)\]\s*/;

export function parsePriority(notes?: string | null): { priority: Priority | null; text: string } {
  if (!notes) return { priority: null, text: '' };
  const m = notes.match(PR_RE);
  if (!m) return { priority: null, text: notes };
  return { priority: m[1] as Priority, text: notes.replace(PR_RE, '') };
}

export function withPriority(notes: string, priority: Priority | null): string {
  const clean = notes.replace(PR_RE, '').trim();
  return priority ? `[${priority}]${clean ? ` ${clean}` : ''}` : clean;
}

// '14:30' -> '2:30 PM'
export function to12h(t?: string | null): string {
  if (!t) return '';
  const [hs, ms] = t.split(':');
  let h = parseInt(hs, 10);
  if (Number.isNaN(h)) return t;
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${(ms ?? '00').padStart(2, '0')} ${suffix}`;
}

export function plusHour(t: string): string {
  const [h, m] = t.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h)) return t;
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}

// Local (not UTC) YYYY-MM-DD.
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Local HH:MM from a Date. */
export function toTimeStr(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Local date + 'HH:MM' → a UTC ISO instant with a `Z` suffix, which is what
 * every write endpoint expects. `new Date(y, m, d, h, min)` builds the instant
 * in the device's zone, so `toISOString()` performs the conversion.
 */
export function toUtcIso(dateStr: string, timeStr?: string | null): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0).toISOString();
}

/** Current instant as an ISO UTC string, for `updatedAt` on writes. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ── View model ───────────────────────────────────────────────────────────────

/**
 * An event or task flattened into the local-time shape the screens render.
 * `kind` keeps the origin so delete/update calls hit the right endpoint —
 * tasks and events are separate resources with separate ids.
 */
export type AgendaItem = {
  id: string;
  kind: 'event' | 'task';
  title: string;
  /** Local YYYY-MM-DD. */
  date: string;
  /** Local HH:MM, or '' for an undated task. */
  time: string;
  /** Free-text note, priority prefix included. */
  notes: string;
  /** Tasks carry explicit completion; events derive it from the clock. */
  isDone?: boolean;
  endsAt?: string;
};

/** Wire event → local-time agenda item. */
export function eventToItem(e: Event): AgendaItem {
  const start = new Date(e.startsAt);
  return {
    id: e.id,
    kind: 'event',
    title: e.title,
    date: toDateStr(start),
    time: toTimeStr(start),
    notes: e.note ?? '',
    endsAt: e.endsAt,
  };
}

/** Wire task → local-time agenda item. Undated tasks get an empty time. */
export function taskToItem(t: Task): AgendaItem {
  const due = t.dueAt ? new Date(t.dueAt) : null;
  return {
    id: t.id,
    kind: 'task',
    title: t.title,
    date: due ? toDateStr(due) : '',
    time: due ? toTimeStr(due) : '',
    notes: t.notes ?? '',
    isDone: t.isDone,
  };
}

/** Drops soft-deleted rows, which sync endpoints deliberately return. */
export function isLive<T extends { deletedAt: string | null }>(row: T): boolean {
  return row.deletedAt === null;
}

export type TaskStatus = 'todo' | 'inprogress' | 'done';

/**
 * A task's status comes from its own `isDone` flag. An event has no such flag,
 * so it is "in progress" for one hour from its start time and done after that.
 */
export function statusOf(item: AgendaItem, now = new Date()): TaskStatus {
  if (item.kind === 'task') {
    if (item.isDone) return 'done';
    if (!item.date) return 'todo';
    // An overdue task still needs doing, so it stays in To Do.
    return 'todo';
  }

  if (!item.time) {
    return item.date && item.date < toDateStr(now) ? 'done' : 'todo';
  }
  const start = new Date(`${item.date}T${item.time.padStart(5, '0')}:00`);
  if (Number.isNaN(start.getTime())) return 'todo';
  const end = item.endsAt
    ? new Date(item.endsAt)
    : new Date(start.getTime() + 60 * 60 * 1000);
  if (now >= end) return 'done';
  if (now >= start) return 'inprogress';
  return 'todo';
}
