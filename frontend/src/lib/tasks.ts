import type { Priority } from '../theme';

// Task helpers shared by the Today / Calendar / Add Task screens.
// Priority is encoded as a "[High] " prefix inside the event's notes field so
// the existing backend schema stays untouched.
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

export type TaskStatus = 'todo' | 'inprogress' | 'done';

// A timed task is "in progress" for one hour from its start time.
export function statusOf(e: { date: string; time?: string | null }, now = new Date()): TaskStatus {
  if (!e.time) {
    return e.date < toDateStr(now) ? 'done' : 'todo';
  }
  const start = new Date(`${e.date}T${e.time.padStart(5, '0')}:00`);
  if (Number.isNaN(start.getTime())) return 'todo';
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  if (now >= end) return 'done';
  if (now >= start) return 'inprogress';
  return 'todo';
}
