import { storage } from './storage';

// API client for the backend described in backend/API_CONTRACT.md.
//
// Contract essentials this file encodes:
//  - No `/api` prefix. Health is `/health`; everything else is `/tasks`,
//    `/events`, `/agenda`, `/me`, `/auth/*`, `/chat/*`, `/devices`.
//  - Every endpoint except `/auth/*` and `/health` needs
//    `Authorization: Bearer <accessToken>`.
//  - Errors come back as `{ error: { code, message, details } }`.
//  - Timestamps are ISO-8601 UTC with a `Z` suffix.
//  - Creates are idempotent on a client-generated UUID: `201` new,
//    `200` replay, `409` if the id belongs to another user.

async function baseUrl(): Promise<string> {
  const s = await storage.getSettings();
  return s.apiBaseUrl.replace(/\/$/, '');
}

/** Error codes from the contract's error envelope. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'INTERNAL';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | string,
    message: string,
    readonly details?: unknown,
    /** Seconds to wait, from the Retry-After header on 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the caller has no valid session and should sign in again. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const retryAfterRaw = res.headers.get('Retry-After');
  const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
  let code = 'INTERNAL';
  let message = res.statusText || `Request failed (${res.status})`;
  let details: unknown;
  try {
    const body = await res.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // Non-JSON body (proxy error page, empty response) — keep the defaults.
  }
  return new ApiError(res.status, code, message, details, retryAfter);
}

type RequestOpts = {
  method?: string;
  body?: unknown;
  /** Skip the Authorization header — for /auth/* and /health. */
  anonymous?: boolean;
  /** Internal: prevents an infinite refresh loop. */
  isRetry?: boolean;
};

/**
 * Refreshes the access token using the stored refresh token. The contract
 * rotates refresh tokens, so the new one must replace the old one — reusing a
 * rotated token returns 401.
 */
async function refreshSession(): Promise<boolean> {
  const session = await storage.getSession();
  if (!session?.refreshToken) return false;
  try {
    const res = await fetch(`${await baseUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!res.ok) {
      // The refresh token is spent or revoked; the session is unrecoverable.
      await storage.clearSession();
      return false;
    }
    const { accessToken, refreshToken } = await res.json();
    await storage.saveSession({ ...session, accessToken, refreshToken });
    return true;
  } catch {
    return false;
  }
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false, isRetry = false } = opts;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous) {
    const session = await storage.getSession();
    if (session?.accessToken) {
      headers.Authorization = `Bearer ${session.accessToken}`;
    }
  }

  const res = await fetch(`${await baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // One transparent refresh attempt on 401, then surface the error.
  if (res.status === 401 && !anonymous && !isRetry) {
    if (await refreshSession()) {
      return request<T>(path, { ...opts, isRetry: true });
    }
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Wire types (exactly the contract's shapes) ───────────────────────────────

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

/** RFC-4122 v4 UUID. Ids are client-generated so creates work offline. */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const api = {
  // ── Health (no auth) ──
  health: () => request<{ status: string }>('/health', { anonymous: true }),

  // ── Auth ──
  signInWithGoogle: (idToken: string, timezone?: string) =>
    request<{ user: User; accessToken: string; refreshToken: string }>(
      '/auth/google',
      { method: 'POST', body: { idToken, timezone }, anonymous: true },
    ),
  signInWithApple: (idToken: string, timezone?: string) =>
    request<{ user: User; accessToken: string; refreshToken: string }>(
      '/auth/apple',
      { method: 'POST', body: { idToken, timezone }, anonymous: true },
    ),
  /**
   * Dev-only sign-in as the seeded local user. The backend mounts this only
   * when NODE_ENV !== 'production'; replace with signInWithGoogle once an
   * OAuth client id is configured.
   */
  signInAsDevUser: () =>
    request<{ user: User; accessToken: string; refreshToken: string }>('/auth/dev', {
      method: 'POST',
      anonymous: true,
    }),
  logout: (refreshToken?: string, pushToken?: string) =>
    request<void>('/auth/logout', {
      method: 'POST',
      body: { refreshToken, pushToken },
    }),

  // ── Users ──
  getMe: () => request<{ user: User }>('/me'),
  updateMe: (patch: Partial<Pick<User, 'name' | 'language' | 'timezone'>>) =>
    request<{ user: User }>('/me', { method: 'PATCH', body: patch }),
  deleteMe: () => request<{ deletionRequestedAt: string }>('/me', { method: 'DELETE' }),

  // ── Tasks ──
  listTasks: (updatedSince?: string) =>
    request<{ tasks: Task[]; serverTime: string }>(
      `/tasks${updatedSince ? `?updatedSince=${encodeURIComponent(updatedSince)}` : ''}`,
    ),
  createTask: (t: {
    id: string;
    title: string;
    notes?: string;
    dueAt?: string;
    updatedAt: string;
  }) => request<Task>('/tasks', { method: 'POST', body: t }),
  updateTask: (
    id: string,
    patch: Partial<Pick<Task, 'title' | 'notes' | 'dueAt' | 'isDone'>> & {
      updatedAt?: string;
    },
  ) => request<Task>(`/tasks/${id}`, { method: 'PATCH', body: patch }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),

  // ── Events ──
  listEvents: (updatedSince?: string) =>
    request<{ events: Event[]; serverTime: string }>(
      `/events${updatedSince ? `?updatedSince=${encodeURIComponent(updatedSince)}` : ''}`,
    ),
  createEvent: (e: {
    id: string;
    title: string;
    note?: string;
    startsAt: string;
    endsAt?: string;
    reminderMinutesBefore?: number | null;
    updatedAt: string;
  }) => request<Event>('/events', { method: 'POST', body: e }),
  updateEvent: (
    id: string,
    patch: Partial<
      Pick<Event, 'title' | 'note' | 'startsAt' | 'endsAt' | 'reminderMinutesBefore'>
    > & { updatedAt?: string },
  ) => request<Event>(`/events/${id}`, { method: 'PATCH', body: patch }),
  deleteEvent: (id: string) => request<void>(`/events/${id}`, { method: 'DELETE' }),

  // ── Agenda: events + tasks for a day or range, in the user's timezone ──
  agendaForDate: (date: string) =>
    request<{ events: Event[]; tasks: Task[] }>(`/agenda?date=${date}`),
  agendaForRange: (from: string, to: string) =>
    request<{ events: Event[]; tasks: Task[] }>(`/agenda?from=${from}&to=${to}`),

  // ── Chat ──
  sendMessage: (text: string) =>
    request<{ messages: ChatMessage[] }>('/chat/message', {
      method: 'POST',
      body: { text },
    }),
  confirmAction: (confirmMessageId: string) =>
    request<{ messages: ChatMessage[] }>('/chat/message', {
      method: 'POST',
      body: { confirmMessageId },
    }),
  chatHistory: (cursor?: string, limit = 50) =>
    request<{ messages: ChatMessage[]; nextCursor: string | null }>(
      `/chat/history?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  // ── Devices ──
  registerDevice: (pushToken: string, platform: 'ios' | 'android' | 'web') =>
    request<{ device: { id: string; platform: string; lastSeenAt: string } }>(
      '/devices',
      { method: 'POST', body: { pushToken, platform } },
    ),
};
