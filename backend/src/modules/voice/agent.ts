import { z } from 'zod';
import type OpenAI from 'openai';

import { getOpenAI } from '../chat/llm.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { reviewSchedule, type KnownEvent, type ProposedEvent } from './schedule.js';

// The voice assistant's turn: what she heard in, what she says back plus the
// changes to apply.
//
// This is the stateless sibling of /chat/message. That endpoint owns rows in
// the database; this one owns nothing. The device stores its own tasks and
// events, so it sends a snapshot of them with every turn and applies the
// actions that come back. The model therefore never touches the data — it
// proposes, the device executes, and an id the model invents cannot match
// anything in the snapshot and is dropped here before it is ever returned.

// ─── Snapshot: what the device knows ────────────────────────────────────────

export const snapshotSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        notes: z.string().nullish(),
        dueAt: z.string().nullish(),
        isDone: z.boolean().default(false),
      }),
    )
    .max(200)
    .default([]),
  events: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        note: z.string().nullish(),
        startsAt: z.string(),
        endsAt: z.string().nullish(),
        /** Free text, as the user typed it. Geocoded when a journey is checked. */
        location: z.string().nullish(),
      }),
    )
    .max(200)
    .default([]),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

// ─── Tools the device executes ──────────────────────────────────────────────

/**
 * Anything that touches an existing entry has to name it as well as identify
 * it. Asked to delete a meeting that isn't there, the model would otherwise
 * pick the nearest row and announce it as the one the user named — which is
 * how "delete my bank meeting" quietly deleted a standup during testing.
 * Writing the title out forces the mismatch into the model's own output, and
 * the server checks it against the row before the action ever reaches the
 * device.
 */
const MATCH_TITLE_HELP =
  'The exact title of the entry you are acting on, copied from the agenda. It must be the entry the user actually named.';

export const ACTION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_image',
      description:
        'Draw a picture, when the user asks for one — an image, a drawing, an illustration. Not for anything that belongs on the agenda.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              "What to draw, in English and in full, however the user phrased it. Say what is in the picture and how it looks; do not name a style unless the user did.",
          },
          shape: {
            type: 'string',
            enum: ['square', 'portrait', 'landscape'],
            description: 'Omit unless the user asked for a shape.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description: 'Add a new task (something to do, with an optional due date).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title, no dates or filler words.' },
          dueAt: {
            type: 'string',
            description: 'ISO-8601 with offset. Omit for a task with no date.',
          },
          notes: { type: 'string' },
          priority: { type: 'string', enum: ['Low', 'Medium', 'High'] },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description:
        'Change an existing task. The id must come from the agenda you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
          title: { type: 'string', description: 'The new title, if it is changing.' },
          dueAt: { type: ['string', 'null'], description: 'ISO-8601 with offset, or null to clear.' },
          notes: { type: 'string' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'complete_task',
      description: 'Mark a task as done.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_task',
      description: 'Delete a task for good.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_note',
      description:
        'File a short note to remember — an idea, a phone number, something to keep, not to do. No due date and nothing to complete: use create_task instead when it is something the user needs to act on.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note itself, in full, as the user said it.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_event',
      description: 'Put something in the calendar at a set time.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startsAt: { type: 'string', description: 'ISO-8601 with offset.' },
          endsAt: { type: 'string', description: 'ISO-8601 with offset. Defaults to an hour later.' },
          note: { type: 'string' },
          location: {
            type: 'string',
            description:
              'Where it happens, if the user said — a city, a place, an address. Used to work out whether they can get there in time from whatever is before it.',
          },
        },
        required: ['title', 'startsAt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_event',
      description: 'Move or rename an event. The id must come from the agenda you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
          title: { type: 'string', description: 'The new title, if it is changing.' },
          startsAt: { type: 'string' },
          endsAt: { type: 'string' },
          note: { type: 'string' },
          location: { type: 'string', description: 'Where it happens, if that is changing.' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_event',
      description: 'Remove an event from the calendar.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
];

const isoString = z.string().min(4);

const ARG_SCHEMAS = {
  // Owns no row, so it is checked against nothing: no id to verify, and
  // nothing on the agenda it could duplicate.
  create_image: z.object({
    prompt: z.string().min(1).max(1000),
    shape: z.enum(['square', 'portrait', 'landscape']).optional(),
  }),
  create_task: z.object({
    title: z.string().min(1),
    dueAt: isoString.optional(),
    notes: z.string().optional(),
    priority: z.enum(['Low', 'Medium', 'High']).optional(),
  }),
  update_task: z.object({
    id: z.string().min(1),
    matchTitle: z.string().min(1),
    title: z.string().min(1).optional(),
    dueAt: z.union([isoString, z.null()]).optional(),
    notes: z.string().optional(),
  }),
  complete_task: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  delete_task: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  create_note: z.object({
    text: z.string().min(1).max(2000),
  }),
  create_event: z.object({
    title: z.string().min(1),
    startsAt: isoString,
    endsAt: isoString.optional(),
    note: z.string().optional(),
    location: z.string().max(120).optional(),
  }),
  update_event: z.object({
    id: z.string().min(1),
    matchTitle: z.string().min(1),
    title: z.string().min(1).optional(),
    startsAt: isoString.optional(),
    endsAt: isoString.optional(),
    note: z.string().optional(),
    location: z.string().max(120).optional(),
  }),
  delete_event: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
} as const;

export type ActionName = keyof typeof ARG_SCHEMAS;

function isActionName(name: string): name is ActionName {
  return name in ARG_SCHEMAS;
}

/** Which snapshot list an action's `id` has to be found in, if it has one. */
const ID_SOURCE: Partial<Record<ActionName, 'tasks' | 'events'>> = {
  update_task: 'tasks',
  complete_task: 'tasks',
  delete_task: 'tasks',
  update_event: 'events',
  delete_event: 'events',
};

/** The day an ISO timestamp falls on, or null when there isn't one. */
function dayOf(iso: string | null | undefined, timezone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Is this create just re-adding something already on the agenda?
 *
 * Asked to add one task and describe the day, the model would sometimes
 * "add" an entry it had merely read out, leaving a duplicate behind. Same
 * title on the same day is not a second thing to do — it is the same thing
 * twice, and the user hears one confirmation either way.
 *
 * A finished task is not in the way: the snapshot carries completed rows so
 * she can say what got done, and someone who ticked off "buy milk" this
 * morning and asks for it again this evening means it.
 */
export function alreadyOnAgenda(
  name: ActionName,
  args: Record<string, unknown>,
  snapshot: Snapshot,
  timezone: string,
): boolean {
  const title = normalizeTitle(String(args.title ?? ''));
  if (!title) return false;

  if (name === 'create_task') {
    const day = dayOf(args.dueAt as string | undefined, timezone);
    return snapshot.tasks.some(
      (t) => !t.isDone && normalizeTitle(t.title) === title && dayOf(t.dueAt, timezone) === day,
    );
  }
  if (name === 'create_event') {
    const day = dayOf(args.startsAt as string | undefined, timezone);
    return snapshot.events.some(
      (e) => normalizeTitle(e.title) === title && dayOf(e.startsAt, timezone) === day,
    );
  }
  return false;
}

/**
 * `offer_times` is the one the model cannot ask for. The server raises it in
 * place of a create or a move it has judged unkeepable, so it is not in
 * `ACTION_TOOLS` and has no argument schema — nothing untrusted ever produces
 * one.
 */
export interface VoiceAction {
  tool: ActionName | 'offer_times';
  arguments: Record<string, unknown>;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

/**
 * Only the opening greeting needs this: she answers every real turn in
 * whatever language the user spoke, but "[SESSION START]" carries no words of
 * theirs to mirror, so the interface language stands in.
 *
 * Every language the interface ships in is here. A code that is not — the
 * route validates the shape of an ISO-639-1 code, not the particular language
 * — greets in English rather than failing the turn.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  he: 'Hebrew',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian',
  de: 'German',
  pt: 'Portuguese',
  hi: 'Hindi',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  tr: 'Turkish',
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
  ro: 'Romanian',
  el: 'Greek',
  sv: 'Swedish',
  fa: 'Persian',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
  bn: 'Bengali',
};

/**
 * The agenda goes into the prompt rather than behind a lookup tool: the device
 * already has it, and one round trip is the difference between a conversation
 * and a wait.
 */
function describeSnapshot(snapshot: Snapshot, timezone: string): string {
  const when = (iso: string | null | undefined) => {
    if (!iso) return 'no date';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'no date';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  };

  const tasks = snapshot.tasks.length
    ? snapshot.tasks
        .map(
          (t) =>
            `- [${t.id}] ${t.title} — due ${when(t.dueAt)}${t.isDone ? ' (done)' : ''}${
              t.notes ? ` — ${t.notes}` : ''
            }`,
        )
        .join('\n')
    : '- (none)';

  const events = snapshot.events.length
    ? snapshot.events
        .map((e) => `- [${e.id}] ${e.title} — ${when(e.startsAt)}${e.note ? ` — ${e.note}` : ''}`)
        .join('\n')
    : '- (none)';

  return `TASKS:\n${tasks}\n\nCALENDAR:\n${events}`;
}

/**
 * The next week, named and dated.
 *
 * Left to work it out from a single timestamp, the model gets "tomorrow" wrong
 * often enough to move a real meeting to the wrong day — it did exactly that
 * in testing. Spelling the days out turns the arithmetic into a lookup.
 */
function describeDays(now: Date, timezone: string): string {
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
  // en-CA gives YYYY-MM-DD, which is the shape the model has to echo back.
  const isoDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const labels = ['Today', 'Tomorrow'];
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const label = labels[i] ?? `In ${i} days`;
    lines.push(`- ${label}: ${dayName.format(d)} ${isoDay.format(d)}`);
  }
  return lines.join('\n');
}

function buildSystemPrompt(input: {
  language: string;
  timezone: string;
  now: Date;
  userName?: string;
  snapshot: Snapshot;
}): string {
  const languageName = LANGUAGE_NAMES[input.language] ?? 'English';
  const localNow = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(input.now);

  return [
    `You are ${input.userName ? `${input.userName}'s` : 'the user’s'} personal assistant.`,
    'You are warm, upbeat and a little playful — a friend who happens to run their diary.',
    '',
    'HOW YOU SPEAK:',
    "- Answer in the language of the user's latest message, whatever it is —",
    '  match their language every turn. If they switch mid-conversation, switch',
    '  with them. Never answer in a different language than they used.',
    `- When there is nothing of theirs to mirror — the "[SESSION START]" turn —`,
    `  speak ${languageName}.`,
    '- You are a woman. In any language that marks gender on verbs and',
    '  adjectives — Hebrew, Arabic, Spanish, French, Italian, Russian and the',
    '  like — always speak about yourself in the feminine.',
    '- Your answer is read aloud, so keep it to one or two short spoken sentences',
    '  on a single line. No line breaks.',
    '- Plain speech only: no markdown, no bullet points, no emoji, no lists of ids.',
    '- Say times the way a person would ("tomorrow at four"), never as ISO timestamps.',
    '- Never tell the user to type, tap or open a form. Anything they ask for, you do.',
    '',
    'WHAT YOU DO:',
    '- Use the tools to create, change, complete and delete tasks and events.',
    '- Use create_note when the user asks you to remember, jot down or file',
    '  something that is not a to-do and not on the calendar — an idea, a',
    '  number, a thought. It carries no due date; if there is a date or',
    '  something to act on, it is a task or an event instead.',
    '- Calling the tool is the only thing that changes anything. Saying "I am',
    '  deleting it" or "I will add that" without a tool call in the same reply',
    '  changes nothing and is a broken promise — so when the user asks for a',
    '  change, call the tool right now, in this reply.',
    '- A request can need several tools at once. Call all of them.',
    '- Touch only what was asked for. Never rewrite an entry the user did not',
    '  mention, and never "tidy up" times or titles on your own.',
    '- Answering a question about the schedule needs no tool: the agenda is',
    '  below. Everything on it already exists — reading an entry out loud is',
    '  never a reason to create it.',
    '- Ids come only from the agenda below. Never invent one.',
    '- Act on an entry only when its title is clearly the one the user named.',
    '  If nothing in the agenda matches, say so — never fall back to the closest',
    '  entry, and never delete something they did not ask about.',
    '- If several entries match what they said, ask which one — briefly.',
    '- If a request is missing a time you cannot reasonably guess, ask one short question.',
    '- After acting, say what you did in one sentence.',
    '- For anything about their schedule, answer from the agenda below.',
    '- The turn "[SESSION START]" is not something they said: they have just',
    '  opened you. Greet them by name in one short line, say what today holds,',
    '  and ask what they need. Call no tools for it.',
    '',
    `The user's local time is ${localNow} (${input.timezone}).`,
    'Resolve "tomorrow", "next Tuesday", "in an hour" against the calendar below,',
    'and give every time back as ISO-8601 with an explicit offset.',
    'When you move something to a named day, its date comes from this list — do',
    'not keep the entry on its old date and change only the time.',
    describeDays(input.now, input.timezone),
    '',
    "THE USER'S CURRENT AGENDA:",
    describeSnapshot(input.snapshot, input.timezone),
  ].join('\n');
}

// ─── The turn ───────────────────────────────────────────────────────────────

export interface VoiceTurnInput {
  text: string;
  /** For the opening greeting only; every other turn mirrors the user. */
  language: string;
  timezone: string;
  now: Date;
  userName?: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  snapshot: Snapshot;
}

export interface VoiceTurnResult {
  reply: string;
  actions: VoiceAction[];
}

/** One extra round so she can act and then narrate what she did. */
const MAX_ROUNDS = 2;

export async function runVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  const client = getOpenAI();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(input) },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.text },
  ];

  const actions: VoiceAction[] = [];
  let reply = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
    const completion = await client.chat.completions.create({
      model: config.OPENAI_VOICE_MODEL,
      messages,
      tools: ACTION_TOOLS,
      // On the final round she has already acted; all that is left is to say so.
      tool_choice: lastRound ? 'none' : 'auto',
      temperature: 0.6,
    });

    const message = completion.choices[0]?.message;
    if (!message) break;

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      reply = message.content?.trim() ?? '';
      break;
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const outcome = collectAction(
        call.function.name,
        call.function.arguments,
        input.snapshot,
        input.timezone,
      );

      // A time that survives the gate still has to be a time the person can
      // keep. That check reaches a geocoder, so it cannot live inside
      // `collectAction`, which is synchronous and stays that way.
      const reviewed = outcome.action
        ? await reviewProposedTime(outcome.action, input.snapshot, input.timezone, input.now.getTime())
        : null;

      if (reviewed) {
        actions.push(reviewed.action);
        messages.push({ role: 'tool', tool_call_id: call.id, content: reviewed.result });
        continue;
      }

      if (outcome.action) actions.push(outcome.action);
      // Every tool_call must be answered or the next request is rejected.
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.result,
      });
    }

    // Anything she said alongside the calls is a partial thought; the closing
    // sentence comes from the next round, once the results are in.
    reply = message.content?.trim() ?? reply;
  }

  return { reply, actions };
}

/**
 * Turns a create or move that cannot be kept into an offer of times that can.
 *
 * Returns null when there is nothing to say — a different tool, no time on it,
 * or a time that is perfectly fine — and the caller carries on unchanged.
 *
 * The model is told the tool did not do what it asked for, in the same shape
 * as any other refusal, so its closing sentence says the meeting was not made
 * and why. What it must not do is describe the alternatives: those are on
 * screen as something to tap, and reading four times aloud is worse than
 * saying there are four.
 */
async function reviewProposedTime(
  action: VoiceAction,
  snapshot: Snapshot,
  timeZone: string,
  now: number,
): Promise<{ action: VoiceAction; result: string } | null> {
  if (action.tool !== 'create_event' && action.tool !== 'update_event') return null;

  const args = action.arguments;
  const startsAt = typeof args.startsAt === 'string' ? args.startsAt : null;
  if (!startsAt) return null;

  const known: KnownEvent[] = snapshot.events.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    location: e.location ?? null,
  }));

  const movingId = action.tool === 'update_event' && typeof args.id === 'string' ? args.id : undefined;
  const moving = movingId ? known.find((e) => e.id === movingId) : undefined;

  const proposed: ProposedEvent = {
    title:
      (typeof args.title === 'string' && args.title) ||
      moving?.title ||
      (typeof args.matchTitle === 'string' ? args.matchTitle : 'the meeting'),
    startsAt,
    endsAt: typeof args.endsAt === 'string' ? args.endsAt : null,
    location:
      (typeof args.location === 'string' && args.location) || moving?.location || null,
  };

  const verdict = await reviewSchedule(proposed, known, timeZone, movingId, now);
  if (verdict.ok) return null;

  const offer: VoiceAction = {
    tool: 'offer_times',
    arguments: {
      reason: verdict.reason,
      title: proposed.title,
      requestedAt: startsAt,
      durationMinutes: verdict.durationMinutes,
      ...(proposed.location ? { location: proposed.location } : {}),
      ...(verdict.reason === 'clash'
        ? { clashWith: verdict.clashWith }
        : { travel: verdict.travel }),
      options: verdict.options,
    },
  };

  const because =
    verdict.reason === 'clash'
      ? `"${verdict.clashWith}" is already at that time.`
      : `They would be at "${verdict.travel.fromTitle}" in ${verdict.travel.fromPlace} and could not reach ${verdict.travel.toPlace} in ${verdict.travel.availableMinutes} minutes — it needs at least ${verdict.travel.neededMinutes}.`;

  return {
    action: offer,
    result: JSON.stringify({
      ok: false,
      error: `Not scheduled. ${because}`,
      offeredCount: verdict.options.length,
      instruction:
        verdict.options.length > 0
          ? 'Say briefly why it does not work and that other times are on screen to choose from. Do NOT read the times out.'
          : 'Say briefly why it does not work, and that nothing else is free — ask what they want to do.',
    }),
  };
}

/** Titles are compared as a person would hear them, not byte for byte. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Validates one tool call. Returns the action to send to the device, plus the
 * result string the model sees next round.
 *
 * Exported for tests: this is the gate every hallucinated id, bogus argument
 * and duplicate has to fail at, and it is worth checking without paying for a
 * round trip to the model to get here.
 */
export function collectAction(
  name: string,
  rawArguments: string,
  snapshot: Snapshot,
  timezone: string,
): { action: VoiceAction | null; result: string } {
  if (!isActionName(name)) {
    logger.warn({ name }, 'voice agent invoked an unknown tool');
    return { action: null, result: JSON.stringify({ ok: false, error: `Unknown tool ${name}` }) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || '{}');
  } catch {
    return { action: null, result: JSON.stringify({ ok: false, error: 'Arguments were not JSON' }) };
  }

  const validated = ARG_SCHEMAS[name].safeParse(parsed);
  if (!validated.success) {
    return {
      action: null,
      result: JSON.stringify({ ok: false, error: 'Invalid arguments', issues: validated.error.issues }),
    };
  }

  // An id the model made up matches nothing the device sent us. Refusing here
  // is what stops a hallucinated id from deleting a real row.
  const source = ID_SOURCE[name];
  if (source) {
    const { id, matchTitle } = validated.data as { id: string; matchTitle: string };
    const row = snapshot[source].find((r) => r.id === id);
    if (!row) {
      logger.warn({ name, id }, 'voice agent referenced an id outside the snapshot');
      return {
        action: null,
        result: JSON.stringify({
          ok: false,
          error: 'No entry with that id. Use an id from the agenda, or ask the user which one.',
        }),
      };
    }
    if (normalizeTitle(row.title) !== normalizeTitle(matchTitle)) {
      logger.warn({ name, id }, 'voice agent named an entry it did not identify');
      return {
        action: null,
        result: JSON.stringify({
          ok: false,
          error: `Entry ${id} is titled "${row.title}", not "${matchTitle}". If nothing in the agenda is what the user meant, tell them so instead of picking the closest one.`,
        }),
      };
    }
  }

  const args = validated.data as Record<string, unknown>;

  if (alreadyOnAgenda(name, args, snapshot, timezone)) {
    logger.warn({ name, title: args.title }, 'voice agent tried to re-add an existing entry');
    return {
      action: null,
      result: JSON.stringify({
        ok: false,
        error: `"${args.title}" is already on the agenda for that day. Mention it rather than adding it again.`,
      }),
    };
  }

  return {
    action: { tool: name, arguments: args },
    result: JSON.stringify({ ok: true }),
  };
}
