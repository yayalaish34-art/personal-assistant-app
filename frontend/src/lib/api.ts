import { storage } from './storage';

// API client. Base URL comes from settings (AsyncStorage) so it can be
// changed at runtime — useful when testing on a physical device where
// "localhost" points at the phone, not your dev machine.
async function baseUrl(): Promise<string> {
  const s = await storage.getSettings();
  return s.apiBaseUrl.replace(/\/$/, '');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${await baseUrl()}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${msg}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type JournalEntry = {
  id: string;
  title: string;
  body: string;
  mood: string;
  createdAt: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  time: string;
  notes: string;
};

export const api = {
  health: () => request<{ status: string }>('/api/health'),

  listJournal: () => request<JournalEntry[]>('/api/journal'),
  createJournal: (e: Pick<JournalEntry, 'title' | 'body' | 'mood'>) =>
    request<JournalEntry>('/api/journal', { method: 'POST', body: JSON.stringify(e) }),
  deleteJournal: (id: string) =>
    request<void>(`/api/journal/${id}`, { method: 'DELETE' }),

  listEvents: (date?: string) =>
    request<CalendarEvent[]>(`/api/events${date ? `?date=${date}` : ''}`),
  createEvent: (e: Pick<CalendarEvent, 'title' | 'date' | 'time' | 'notes'>) =>
    request<CalendarEvent>('/api/events', { method: 'POST', body: JSON.stringify(e) }),
  deleteEvent: (id: string) =>
    request<void>(`/api/events/${id}`, { method: 'DELETE' }),
};
