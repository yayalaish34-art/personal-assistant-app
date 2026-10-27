import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import {
  api,
  uuid,
  type Task,
  type Event,
  type ShoppingCategory,
  type IncomeCategory,
  type ExpenseCategory,
} from './api';
import { getVoiceLanguage } from './i18n';
import { getLocation } from './location';
import { storage } from './storage';
import { monthKey, shiftMonth } from './finance';
import { sameItem } from './shopping';

// The voice assistant's side of the wire.
//
// The device owns the data, so every turn carries a snapshot of it: what she
// can see is what is on this phone. The server owns the keys — OpenAI for
// understanding, ElevenLabs for the voice — and hands back what she said plus
// the changes to make. Those changes are applied here, locally, by
// `applyActions`.

const API_BASE = (process.env.EXPO_PUBLIC_API_URL || 'https://personal-assistant-api-production-618a.up.railway.app').replace(/\/$/, '');
const TRANSCRIBE_URL = `${API_BASE}/transcribe`;
const TURN_URL = `${API_BASE}/voice/turn`;
const SPEAK_URL = `${API_BASE}/voice/speak`;
const IMAGE_URL = `${API_BASE}/image`;

// The user picks their language in onboarding. That language is sent as a hint
// to the transcriber to avoid wrong-language guesses from room
// echo, and to the model so it always answers in the right language.

// ── Speech in ───────────────────────────────────────────────────────────────

/**
 * Uploads a recording and returns what was said.
 *
 * Speech-to-text runs on the server because it needs the OpenAI key. The audio
 * is streamed to the provider and not stored. Multipart is built by hand
 * rather than through a JSON helper: setting Content-Type manually would drop
 * the boundary fetch generates, and the upload would be rejected.
 */
export async function transcribe(uri: string): Promise<string> {
  const form = new FormData();

  const blob = await (await fetch(uri)).blob();
  const name = uri.split('/').pop() || 'recording.m4a';
  const ext = name.split('.').pop()?.toLowerCase() || 'm4a';
  form.append('audio', blob, ext === 'webm' ? 'recording.webm' : 'recording.m4a');

  // Send the user's chosen language to avoid guessing random
  // languages from room echo or short utterances.
  form.append('language', getVoiceLanguage());

  const res = await fetch(TRANSCRIBE_URL, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `Transcription failed (${res.status})`;
    // Hearing and thinking are billed to the same account, so an exhausted
    // quota surfaces here first — and is just as final here as it is there.
    throw classifyFailure(message, res.status) ?? new Error(message);
  }
  const { text } = (await res.json()) as { text: string };
  return text;
}

// ── Speech out ──────────────────────────────────────────────────────────────

/**
 * Where to fetch the spoken version of a line.
 *
 * A URL rather than downloaded bytes: the audio player takes a source it can
 * stream, and the device has nowhere useful to put an mp3 anyway.
 */
export function speechUrl(text: string, token?: string): string {
  const base = `${SPEAK_URL}?text=${encodeURIComponent(text)}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

// ── The turn ────────────────────────────────────────────────────────────────

export type VoiceAction = { tool: string; arguments: Record<string, unknown> };

/**
 * A failure the user has to act on, rather than one worth retrying.
 *
 * Retrying an exhausted quota or a missing key just spends the turn again and
 * says "sorry, I lost that one" a second time, which is what made a dead
 * account look like a flaky microphone. `fatal` means: stop the loop and tell
 * them what is actually wrong.
 */
export class VoiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'quota' | 'unconfigured' | 'server',
  ) {
    super(message);
    this.name = 'VoiceUnavailableError';
  }
}

/** Reads a server error message and says whether it can be retried at all. */
function classifyFailure(message: string, status: number): VoiceUnavailableError | null {
  const m = message.toLowerCase();
  if (m.includes('no credits') || m.includes('quota') || m.includes('429') || status === 429) {
    return new VoiceUnavailableError(message, 'quota');
  }
  if (m.includes('not configured') || m.includes('api key') || status === 401 || status === 403) {
    return new VoiceUnavailableError(message, 'unconfigured');
  }
  return null;
}

/**
 * Asks for a picture and keeps it, returning a `file://` uri.
 *
 * The bytes go to a file rather than into the conversation: AsyncStorage is a
 * key-value store meant for small strings, and a single generated image is
 * over a megabyte before base64 adds a third on top. The thread keeps the
 * path, which is what makes a picture survive closing the app without the
 * store having to carry it.
 *
 * Lives in the document directory, not the cache, so the system cannot delete
 * it out from under a conversation that still shows it.
 */
export async function generateImage(
  prompt: string,
  shape?: string,
): Promise<string> {
  const res = await fetch(IMAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, ...(shape ? { shape } : {}) }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `The picture could not be drawn (${res.status})`);
  }

  const { image } = (await res.json()) as { image: string };
  if (!image) throw new Error('The picture came back empty');

  const folder = new Directory(Paths.document, 'images');
  if (!folder.exists) folder.create({ intermediates: true });

  const file = new File(folder, `${uuid()}.png`);
  file.create();
  file.write(image, { encoding: 'base64' });
  return file.uri;
}

// ── When the time she was given will not work ───────────────────────────────

export interface TimeOffer {
  /** Whether the hour was taken, or free but unreachable. */
  reason: 'clash' | 'travel';
  title: string;
  durationMinutes: number;
  requestedAt: string;
  location?: string;
  /** The meeting already sitting there. */
  clashWith?: string;
  travel?: {
    fromTitle: string;
    fromPlace: string;
    toPlace: string;
    availableMinutes: number;
    neededMinutes: number;
  };
  /** Free, reachable starts. Best first, as the server ranked them. */
  options: string[];
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * Reads an `offer_times` action, or returns null.
 *
 * Everything is re-checked rather than trusted: the times are sorted into
 * clock order for display, and anything that has since gone by is dropped —
 * the offer can sit on screen for minutes before anyone taps it.
 */
export function parseOffer(args: Record<string, unknown>): TimeOffer | null {
  const title = str(args.title);
  const requestedAt = str(args.requestedAt);
  if (!title || !requestedAt) return null;

  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw
    .filter((o): o is string => typeof o === 'string')
    .filter((o) => {
      const t = new Date(o).getTime();
      return !Number.isNaN(t) && t > Date.now();
    })
    // The server ranks by closeness; a list is read down the page.
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const minutes = Number(args.durationMinutes);
  const travel = args.travel as TimeOffer['travel'] | undefined;

  return {
    reason: args.reason === 'travel' ? 'travel' : 'clash',
    title,
    requestedAt,
    durationMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 60,
    location: str(args.location),
    clashWith: str(args.clashWith),
    ...(travel && typeof travel === 'object' ? { travel } : {}),
    options,
  };
}

// ── Cards for structured content ───────────────────────────────────────────

export interface CardSet {
  title?: string;
  items: Array<{ label: string; detail?: string }>;
  selectable?: boolean;
}

export function parseCards(args: Record<string, unknown>): CardSet | null {
  const raw = Array.isArray(args.cards) ? args.cards : [];
  const items = raw
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).label === 'string',
    )
    .map((c) => ({
      label: c.label as string,
      ...(typeof c.detail === 'string' ? { detail: c.detail } : {}),
    }));
  if (items.length < 2) return null;
  return {
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    items,
    selectable: args.selectable === true,
  };
}

// ── Checklist for tasks / shopping ─────────────────────────────────────────

export interface ChecklistData {
  title?: string;
  kind: 'tasks' | 'shopping';
  items: Array<{ id: string; label: string; checked: boolean; detail?: string }>;
}

export function parseChecklist(args: Record<string, unknown>): ChecklistData | null {
  const kind = args.kind === 'shopping' ? 'shopping' : 'tasks';
  const raw = Array.isArray(args.items) ? args.items : [];
  const items = raw
    .filter(
      (i): i is Record<string, unknown> =>
        typeof i === 'object' && i !== null &&
        typeof (i as Record<string, unknown>).id === 'string' &&
        typeof (i as Record<string, unknown>).label === 'string',
    )
    .map((i) => ({
      id: i.id as string,
      label: i.label as string,
      checked: i.checked === true,
      ...(typeof i.detail === 'string' ? { detail: i.detail } : {}),
    }));
  if (items.length === 0) return null;
  return {
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    kind,
    items,
  };
}

// ── Confirmation card ─────────────────────────────────────────────────────

export interface ConfirmationData {
  title: string;
  fields: Array<{ label: string; value: string }>;
}

export function parseConfirmation(args: Record<string, unknown>): ConfirmationData | null {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return null;
  const raw = Array.isArray(args.fields) ? args.fields : [];
  const fields = raw
    .filter(
      (f): f is Record<string, unknown> =>
        typeof f === 'object' && f !== null &&
        typeof (f as Record<string, unknown>).label === 'string' &&
        typeof (f as Record<string, unknown>).value === 'string',
    )
    .map((f) => ({ label: f.label as string, value: f.value as string }));
  if (fields.length === 0) return null;
  return { title, fields };
}

// ── Budget gauges ─────────────────────────────────────────────────────────

export interface BudgetData {
  title?: string;
  categories: Array<{ name: string; spent: number; limit: number }>;
}

export function parseBudget(args: Record<string, unknown>): BudgetData | null {
  const raw = Array.isArray(args.categories) ? args.categories : [];
  const categories = raw
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null &&
        typeof (c as Record<string, unknown>).name === 'string' &&
        typeof (c as Record<string, unknown>).spent === 'number' &&
        typeof (c as Record<string, unknown>).limit === 'number',
    )
    .map((c) => ({
      name: c.name as string,
      spent: c.spent as number,
      limit: c.limit as number,
    }));
  if (categories.length === 0) return null;
  return {
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    categories,
  };
}

// ── Day timeline ──────────────────────────────────────────────────────────

export interface TimelineData {
  title?: string;
  events: Array<{ title: string; start: string; end?: string }>;
}

export function parseTimeline(args: Record<string, unknown>): TimelineData | null {
  const raw = Array.isArray(args.events) ? args.events : [];
  const events = raw
    .filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null &&
        typeof (e as Record<string, unknown>).title === 'string' &&
        typeof (e as Record<string, unknown>).start === 'string',
    )
    .map((e) => ({
      title: e.title as string,
      start: e.start as string,
      ...(typeof e.end === 'string' ? { end: e.end } : {}),
    }));
  if (events.length === 0) return null;
  return {
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    events,
  };
}

// ── Quick action chips ────────────────────────────────────────────────────

export interface QuickActionsData {
  actions: Array<{ label: string }>;
}

export function parseActions(args: Record<string, unknown>): QuickActionsData | null {
  const raw = Array.isArray(args.actions) ? args.actions : [];
  const actions = raw
    .filter(
      (a): a is Record<string, unknown> =>
        typeof a === 'object' && a !== null &&
        typeof (a as Record<string, unknown>).label === 'string',
    )
    .map((a) => ({ label: a.label as string }));
  if (actions.length < 2) return null;
  return { actions };
}

// ── Debt cards ────────────────────────────────────────────────────────────

export interface DebtData {
  title?: string;
  debts: Array<{
    id: string;
    person: string;
    amount: number;
    direction: 'owe' | 'owed';
    description?: string;
  }>;
}

export function parseDebt(args: Record<string, unknown>): DebtData | null {
  const raw = Array.isArray(args.debts) ? args.debts : [];
  const debts = raw
    .filter(
      (d): d is Record<string, unknown> =>
        typeof d === 'object' && d !== null &&
        typeof (d as Record<string, unknown>).id === 'string' &&
        typeof (d as Record<string, unknown>).person === 'string' &&
        typeof (d as Record<string, unknown>).amount === 'number' &&
        typeof (d as Record<string, unknown>).direction === 'string',
    )
    .map((d) => ({
      id: d.id as string,
      person: d.person as string,
      amount: d.amount as number,
      direction: (d.direction === 'owe' ? 'owe' : 'owed') as 'owe' | 'owed',
      ...(typeof d.description === 'string' ? { description: d.description } : {}),
    }));
  if (debts.length === 0) return null;
  return {
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    debts,
  };
}

// ── Weather cards ──────────────────────────────────────────────────────────

export interface WeatherData {
  location?: string;
  days: Array<{
    day: string;
    icon: 'sun' | 'cloud' | 'rain' | 'storm' | 'snow' | 'partly_cloudy' | 'wind' | 'fog';
    high: number;
    low: number;
    description?: string;
  }>;
}

export function parseWeather(args: Record<string, unknown>): WeatherData | null {
  const raw = Array.isArray(args.days) ? args.days : [];
  const days = raw
    .filter(
      (d): d is Record<string, unknown> =>
        typeof d === 'object' && d !== null &&
        typeof (d as Record<string, unknown>).day === 'string' &&
        typeof (d as Record<string, unknown>).icon === 'string' &&
        typeof (d as Record<string, unknown>).high === 'number' &&
        typeof (d as Record<string, unknown>).low === 'number',
    )
    .map((d) => ({
      day: d.day as string,
      icon: d.icon as WeatherData['days'][number]['icon'],
      high: d.high as number,
      low: d.low as number,
      ...(typeof d.description === 'string' ? { description: d.description } : {}),
    }));
  if (days.length === 0) return null;
  return {
    ...(typeof args.location === 'string' ? { location: args.location } : {}),
    days,
  };
}

// ── Summary cards ──────────────────────────────────────────────────────────

export interface SummaryData {
  title: string;
  stats?: Array<{
    label: string;
    value: string;
    trend?: 'up' | 'down' | 'neutral';
  }>;
  highlights?: string[];
}

export function parseSummary(args: Record<string, unknown>): SummaryData | null {
  if (typeof args.title !== 'string') return null;
  const stats = Array.isArray(args.stats)
    ? (args.stats as Record<string, unknown>[])
        .filter(
          (s) =>
            typeof s === 'object' && s !== null &&
            typeof (s as Record<string, unknown>).label === 'string' &&
            typeof (s as Record<string, unknown>).value === 'string',
        )
        .map((s) => ({
          label: s.label as string,
          value: s.value as string,
          ...(typeof s.trend === 'string' ? { trend: s.trend as 'up' | 'down' | 'neutral' } : {}),
        }))
    : undefined;
  const highlights = Array.isArray(args.highlights)
    ? (args.highlights as unknown[]).filter((h): h is string => typeof h === 'string')
    : undefined;
  if (!stats?.length && !highlights?.length) return null;
  return {
    title: args.title,
    ...(stats?.length ? { stats } : {}),
    ...(highlights?.length ? { highlights } : {}),
  };
}

export type TurnMessage = { role: 'user' | 'assistant'; content: string };

// ── The conversation, kept across visits ────────────────────────────────────
//
// Closing the screen ends the listening loop, not the conversation: reopening
// within the window below picks the same thread back up, so "and move that one
// too" still means something an hour later.

const CONVERSATION_KEY = '@pa/voiceConversation';

/** After this long without a word, the next visit starts fresh. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How much of the thread is kept on the device. */
const KEEP_TURNS = 60;

/** How much of it rides along with each request. */
const SEND_TURNS = 24;

type StoredConversation = { at: number; history: TurnMessage[] };

export async function loadConversation(): Promise<TurnMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(CONVERSATION_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw) as StoredConversation;
    if (!Array.isArray(saved?.history)) return [];
    if (Date.now() - saved.at > RESUME_WINDOW_MS) return [];
    return saved.history;
  } catch {
    return [];
  }
}

export async function saveConversation(history: TurnMessage[]): Promise<void> {
  try {
    const trimmed = history.slice(-KEEP_TURNS);
    await AsyncStorage.setItem(
      CONVERSATION_KEY,
      JSON.stringify({ at: Date.now(), history: trimmed } satisfies StoredConversation),
    );
  } catch {
    // Losing the thread is survivable; failing the turn is not.
  }
}

export async function clearConversation(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CONVERSATION_KEY);
  } catch {
    /* nothing to do */
  }
}

export interface TurnResult {
  reply: string;
  actions: VoiceAction[];
  canSpeak: boolean;
  /**
   * Whether there were words in the turn at all.
   *
   * False when the audio carried nothing the transcriber would commit to — a
   * word said too quietly, a cough, a sentence the room swallowed. The reply
   * is then a request to say it again, and it belongs to no one: it is not an
   * answer to anything the user said, so it must stay out of the history or
   * she will read it back as though it were part of the conversation.
   *
   * Optional because a server from before this field existed simply omits it,
   * and a turn with words in it is the safe assumption.
   */
  heard?: boolean;
  speakToken?: string;
}

/**
 * Builds the snapshot and profile together in one parallel fetch, so the
 * profile is not fetched a second time in voiceTurn.
 */
export async function buildSnapshotWithProfile() {
  const [snapshot, profile] = await Promise.all([
    buildSnapshot(),
    storage.getProfile(),
  ]);
  return { snapshot, profile };
}

/**
 * Everything she is allowed to know: this device's live tasks and events, the
 * shopping list, this month's and last month's money, the debts and budgets.
 */
export async function buildSnapshot() {
  const [{ tasks }, { events }, { items }, { entries }, { debts }, budgets, profile] =
    await Promise.all([
      api.listTasks(),
      api.listEvents(),
      api.listShopping(),
      api.listMoney(),
      api.listDebts(),
      api.getBudgets(),
      storage.getProfile(),
    ]);
  // Two months is enough for "how much this month" and "compared to last".
  const since = shiftMonth(monthKey(), -1);

  const live = <T extends { deletedAt: string | null }>(rows: T[]) =>
    rows.filter((r) => !r.deletedAt);

  // A whole year of history would crowd out the conversation; recent past and
  // the month ahead is what anyone actually asks about.
  const from = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const to = Date.now() + 31 * 24 * 60 * 60 * 1000;
  const inWindow = (iso: string | null) => {
    if (!iso) return true; // an undated task is always relevant
    const t = new Date(iso).getTime();
    return Number.isNaN(t) || (t >= from && t <= to);
  };

  return {
    tasks: live(tasks)
      .filter((t) => inWindow(t.dueAt))
      .slice(0, 120)
      .map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes,
        dueAt: t.dueAt,
        isDone: t.isDone,
        // Nonzero means this task has been pushed later before — the agent
        // uses it to notice a pattern instead of silently moving it again.
        postponeCount: t.postponeCount ?? 0,
        lastPostponedAt: t.lastPostponedAt ?? null,
      })),
    events: live(events)
      .filter((e) => inWindow(e.startsAt))
      .slice(0, 120)
      .map((e) => ({
        id: e.id,
        title: e.title,
        note: e.note,
        // Without this the server cannot tell Jerusalem from Haifa, and every
        // journey looks possible.
        location: e.location ?? null,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
      })),
    shopping: items.slice(0, 200).map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      isBought: i.isBought,
    })),
    money: entries
      .filter((e) => e.date.slice(0, 7) >= since)
      .slice(0, 400)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        description: e.description,
        amount: e.amount,
        date: e.date,
        category: e.category,
      })),
    debts: debts.slice(0, 100).map((d) => ({
      id: d.id,
      direction: d.direction,
      person: d.person,
      amount: d.amount,
      description: d.description,
      isSettled: d.isSettled,
    })),
    budgets,
    currency: profile.currency,
  };
}

/** Sends one spoken turn and returns what she says back, plus what to change. */
export async function voiceTurn(
  text: string,
  history: TurnMessage[],
  userName?: string,
  prebuiltSnapshot?: { snapshot: Awaited<ReturnType<typeof buildSnapshot>>; profile: unknown },
): Promise<TurnResult> {
  const { snapshot, profile } = prebuiltSnapshot ?? await buildSnapshotWithProfile();
  const location = getLocation();

  const res = await fetch(TURN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      language: getVoiceLanguage(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      now: new Date().toISOString(),
      ...(userName ? { userName } : {}),
      history: history.slice(-SEND_TURNS),
      snapshot,
      profile,
      ...(location ? { location } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `The assistant is unavailable (${res.status})`;
    throw classifyFailure(message, res.status) ?? new Error(message);
  }

  return (await res.json()) as TurnResult;
}

// ── Applying what she decided ───────────────────────────────────────────────

/** A change that has been applied and can still be taken back. */
export interface AppliedChange {
  /** What was removed, so it can be put back verbatim. */
  undo: () => Promise<void>;
  /** Title of the entry, for the undo prompt. */
  title: string;
  destructive: boolean;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Local YYYY-MM-DD, for a money entry the user gave no date for. */
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO in, ISO out — and anything unparseable is treated as absent. */
function isoOrUndefined(v: unknown): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Applies the actions from one turn to local storage.
 *
 * Deletions are reversible: the row is kept in memory and `undo` writes it
 * back, because the only signal that she removed the wrong thing is the user
 * hearing it a second later.
 */
export async function applyActions(actions: VoiceAction[]): Promise<AppliedChange[]> {
  const applied: AppliedChange[] = [];

  for (const action of actions) {
    const args = action.arguments ?? {};
    try {
      switch (action.tool) {
        case 'create_task': {
          const title = asString(args.title);
          if (!title) break;
          const priority = asString(args.priority);
          const notes = asString(args.notes);
          const id = uuid();
          await api.createTask({
            id,
            title,
            // Priority rides along in the notes, the way the entry form writes it.
            ...(notes || priority
              ? { notes: priority ? `[${priority}] ${notes ?? ''}`.trim() : notes! }
              : {}),
            ...(isoOrUndefined(args.dueAt) ? { dueAt: isoOrUndefined(args.dueAt)! } : {}),
            updatedAt: new Date().toISOString(),
          });
          applied.push({
            title,
            destructive: false,
            undo: () => api.deleteTask(id),
          });
          break;
        }

        case 'update_task': {
          const id = asString(args.id);
          if (!id) break;
          const before = await findTask(id);
          if (!before) break;
          const patch: Record<string, unknown> = {};
          if (asString(args.title)) patch.title = asString(args.title);
          if ('dueAt' in args) patch.dueAt = args.dueAt === null ? null : isoOrUndefined(args.dueAt);
          if (asString(args.notes)) patch.notes = asString(args.notes);
          // She sometimes restates a value she was not asked to change; writing
          // it back would bump updatedAt for nothing.
          if (!changesAnything(before as unknown as Record<string, unknown>, patch)) break;
          await api.updateTask(id, patch);
          applied.push({
            title: before.title,
            destructive: false,
            undo: () =>
              api
                .updateTask(id, {
                  title: before.title,
                  notes: before.notes,
                  dueAt: before.dueAt,
                })
                .then(() => undefined),
          });
          break;
        }

        case 'complete_task': {
          const id = asString(args.id);
          if (!id) break;
          const before = await findTask(id);
          if (!before || before.isDone) break;
          await api.updateTask(id, { isDone: true });
          applied.push({
            title: before.title,
            destructive: false,
            undo: () => api.updateTask(id, { isDone: false }).then(() => undefined),
          });
          break;
        }

        case 'delete_task': {
          const id = asString(args.id);
          if (!id) break;
          const before = await findTask(id);
          if (!before) break;
          await api.deleteTask(id);
          applied.push({
            title: before.title,
            destructive: true,
            undo: async () => {
              await api.createTask({
                id: before.id,
                title: before.title,
                ...(before.notes ? { notes: before.notes } : {}),
                ...(before.dueAt ? { dueAt: before.dueAt } : {}),
                updatedAt: new Date().toISOString(),
              });
              if (before.isDone) await api.updateTask(before.id, { isDone: true });
            },
          });
          break;
        }

        case 'add_shopping_item': {
          const name = asString(args.name);
          if (!name) break;
          // Already bought and asked for again: back onto the list, not a twin.
          const { items } = await api.listShopping();
          const existing = items.find((i) => sameItem(i.name, name));
          if (existing?.isBought) {
            await api.updateShoppingItem(existing.id, {
              isBought: false,
              ...(asString(args.quantity) ? { quantity: asString(args.quantity) } : {}),
            });
            applied.push({
              title: name,
              destructive: false,
              undo: () =>
                api.updateShoppingItem(existing.id, {
                  isBought: true,
                  quantity: existing.quantity,
                }).then(() => undefined),
            });
            break;
          }
          if (existing) break;
          const id = uuid();
          await api.createShoppingItem({
            id,
            name,
            quantity: asString(args.quantity) ?? null,
            note: asString(args.note) ?? null,
            category: (asString(args.category) as ShoppingCategory | undefined) ?? null,
            updatedAt: new Date().toISOString(),
          });
          applied.push({
            title: name,
            destructive: false,
            undo: () => api.deleteShoppingItem(id),
          });
          break;
        }

        case 'add_money_entry': {
          const description = asString(args.description);
          const kind = args.kind === 'income' ? 'income' : 'expense';
          const amount = Number(args.amount);
          if (!description || !Number.isFinite(amount) || amount <= 0) break;
          const id = uuid();
          await api.createMoneyEntry({
            id,
            kind,
            description,
            amount,
            // The server only sends a date when the user gave one; today is
            // the sane default for "I just spent forty on lunch".
            date: asString(args.date) ?? localToday(),
            category:
              (asString(args.category) as IncomeCategory | ExpenseCategory | undefined) ?? null,
            updatedAt: new Date().toISOString(),
          });
          applied.push({
            title: description,
            destructive: false,
            undo: () => api.deleteMoneyEntry(id),
          });
          break;
        }

        case 'check_shopping_item':
        case 'remove_shopping_item': {
          const id = asString(args.id);
          if (!id) break;
          const { items } = await api.listShopping();
          const before = items.find((i) => i.id === id);
          if (!before) break;
          if (action.tool === 'check_shopping_item') {
            if (before.isBought) break;
            await api.updateShoppingItem(id, { isBought: true });
            applied.push({
              title: before.name,
              destructive: false,
              undo: () => api.updateShoppingItem(id, { isBought: false }).then(() => undefined),
            });
          } else {
            await api.deleteShoppingItem(id);
            applied.push({
              title: before.name,
              destructive: true,
              undo: async () => {
                await api.createShoppingItem({ ...before, updatedAt: new Date().toISOString() });
                if (before.isBought) await api.updateShoppingItem(id, { isBought: true });
              },
            });
          }
          break;
        }

        case 'delete_money_entry': {
          const id = asString(args.id);
          if (!id) break;
          const { entries } = await api.listMoney();
          const before = entries.find((e) => e.id === id);
          if (!before) break;
          await api.deleteMoneyEntry(id);
          applied.push({
            title: before.description,
            destructive: true,
            undo: () => api.restoreMoneyEntry(before),
          });
          break;
        }

        case 'add_debt': {
          const person = asString(args.person);
          const amount = Number(args.amount);
          if (!person || !Number.isFinite(amount) || amount <= 0) break;
          const id = uuid();
          await api.createDebt({
            id,
            direction: args.direction === 'owe' ? 'owe' : 'owed',
            person,
            amount,
            description: asString(args.description) ?? null,
            date: localToday(),
            updatedAt: new Date().toISOString(),
          });
          applied.push({ title: person, destructive: false, undo: () => api.deleteDebt(id) });
          break;
        }

        case 'settle_debt': {
          const id = asString(args.id);
          if (!id) break;
          const { debts } = await api.listDebts();
          const before = debts.find((d) => d.id === id);
          if (!before || before.isSettled) break;
          await api.updateDebt(id, { isSettled: true });
          applied.push({
            title: before.person,
            destructive: false,
            undo: () => api.updateDebt(id, { isSettled: false }).then(() => undefined),
          });
          break;
        }

        case 'create_event': {
          const title = asString(args.title);
          const startsAt = isoOrUndefined(args.startsAt);
          if (!title || !startsAt) break;
          const id = uuid();
          await api.createEvent({
            id,
            title,
            ...(asString(args.note) ? { note: asString(args.note)! } : {}),
            startsAt,
            ...(isoOrUndefined(args.endsAt) ? { endsAt: isoOrUndefined(args.endsAt)! } : {}),
            reminderMinutesBefore: 15,
            updatedAt: new Date().toISOString(),
          });
          applied.push({ title, destructive: false, undo: () => api.deleteEvent(id) });
          break;
        }

        case 'update_event': {
          const id = asString(args.id);
          if (!id) break;
          const before = await findEvent(id);
          if (!before) break;
          const patch: Record<string, unknown> = {};
          if (asString(args.title)) patch.title = asString(args.title);
          if (asString(args.note)) patch.note = asString(args.note);
          const startsAt = isoOrUndefined(args.startsAt);
          const endsAt = isoOrUndefined(args.endsAt);
          if (startsAt) {
            patch.startsAt = startsAt;
            // Moving an event keeps its length unless she said otherwise —
            // otherwise a 30-minute standup silently becomes an hour.
            patch.endsAt =
              endsAt ??
              new Date(
                new Date(startsAt).getTime() +
                  (new Date(before.endsAt).getTime() - new Date(before.startsAt).getTime()),
              ).toISOString();
          } else if (endsAt) {
            patch.endsAt = endsAt;
          }
          if (!changesAnything(before as unknown as Record<string, unknown>, patch)) break;
          await api.updateEvent(id, patch);
          applied.push({
            title: before.title,
            destructive: false,
            undo: () =>
              api
                .updateEvent(id, {
                  title: before.title,
                  note: before.note,
                  startsAt: before.startsAt,
                  endsAt: before.endsAt,
                })
                .then(() => undefined),
          });
          break;
        }

        case 'delete_event': {
          const id = asString(args.id);
          if (!id) break;
          const before = await findEvent(id);
          if (!before) break;
          await api.deleteEvent(id);
          applied.push({
            title: before.title,
            destructive: true,
            undo: async () => {
              await api.createEvent({
                id: before.id,
                title: before.title,
                ...(before.note ? { note: before.note } : {}),
                startsAt: before.startsAt,
                endsAt: before.endsAt,
                reminderMinutesBefore: before.reminderMinutesBefore,
                updatedAt: new Date().toISOString(),
              });
            },
          });
          break;
        }

        default:
          // An action this build does not know about is skipped rather than
          // guessed at.
          break;
      }
    } catch {
      // One failed change should not stop the rest, and never the reply.
    }
  }

  return applied;
}

function changesAnything(before: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const current = before[key];
    if (value === undefined) return false;
    // Times differ in formatting but not in meaning ("+03:00" vs "Z").
    if (typeof value === 'string' && typeof current === 'string') {
      const a = new Date(value).getTime();
      const b = new Date(current).getTime();
      if (!Number.isNaN(a) && !Number.isNaN(b)) return a !== b;
    }
    return value !== current;
  });
}

async function findTask(id: string): Promise<Task | undefined> {
  const { tasks } = await api.listTasks();
  return tasks.find((t) => t.id === id && !t.deletedAt);
}

async function findEvent(id: string): Promise<Event | undefined> {
  const { events } = await api.listEvents();
  return events.find((e) => e.id === id && !e.deletedAt);
}
