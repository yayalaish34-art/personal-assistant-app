import { z } from 'zod';
import type OpenAI from 'openai';

import { getOpenAI } from '../chat/llm.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

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
      name: 'create_event',
      description: 'Put something in the calendar at a set time.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startsAt: { type: 'string', description: 'ISO-8601 with offset.' },
          endsAt: { type: 'string', description: 'ISO-8601 with offset. Defaults to an hour later.' },
          note: { type: 'string' },
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
  create_event: z.object({
    title: z.string().min(1),
    startsAt: isoString,
    endsAt: isoString.optional(),
    note: z.string().optional(),
  }),
  update_event: z.object({
    id: z.string().min(1),
    matchTitle: z.string().min(1),
    title: z.string().min(1).optional(),
    startsAt: isoString.optional(),
    endsAt: isoString.optional(),
    note: z.string().optional(),
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

export interface VoiceAction {
  tool: ActionName;
  arguments: Record<string, unknown>;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian',
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
    `- Always answer in ${languageName}. Never switch language, whatever language the request arrives in.`,
    '- You are a woman. In languages that mark gender on verbs and adjectives —',
    '  Hebrew, Arabic, Spanish, French, Italian, Russian — always speak about',
    '  yourself in the feminine.',
    '- Your answer is read aloud, so keep it to one or two short spoken sentences',
    '  on a single line. No line breaks.',
    '- Plain speech only: no markdown, no bullet points, no emoji, no lists of ids.',
    '- Say times the way a person would ("tomorrow at four"), never as ISO timestamps.',
    '- Never tell the user to type, tap or open a form. Anything they ask for, you do.',
    '',
    'WHAT YOU DO:',
    '- Use the tools to create, change, complete and delete tasks and events.',
    '- Calling the tool is the only thing that changes anything. Saying "I am',
    '  deleting it" or "I will add that" without a tool call in the same reply',
    '  changes nothing and is a broken promise — so when the user asks for a',
    '  change, call the tool right now, in this reply.',
    '- A request can need several tools at once. Call all of them.',
    '- Touch only what was asked for. Never rewrite an entry the user did not',
    '  mention, and never "tidy up" times or titles on your own.',
    '- Answering a question about the schedule needs no tool: the agenda is below.',
    '- Ids come only from the agenda below. Never invent one.',
    '- An entry marked (done) is finished business. Asking for the same thing',
    '  again means they want it again: call create_task for a new one. Never',
    '  reopen, rename or re-complete the finished entry — "buy milk" done last',
    '  week and "buy milk" today are two different errands.',
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
      // An empty closing round must not erase what she already said. It
      // happens after a tool call — she says "adding that now", acts, and the
      // narrating round comes back blank — and overwriting left the device
      // with no line to show and nothing to speak, so a change landed in
      // total silence.
      const said = message.content?.trim();
      if (said) reply = said;
      break;
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const outcome = collectAction(call.function.name, call.function.arguments, input.snapshot);
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

/** Titles are compared as a person would hear them, not byte for byte. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Validates one tool call. Returns the action to send to the device, plus the
 * result string the model sees next round.
 */
function collectAction(
  name: string,
  rawArguments: string,
  snapshot: Snapshot,
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

  return {
    action: { tool: name, arguments: validated.data as Record<string, unknown> },
    result: JSON.stringify({ ok: true }),
  };
}
