import { uuid, type ChatMessage } from './api';

// Assistant request handling.
//
// Language understanding runs on the backend (POST /parse), because the OpenAI
// key must never ship to a device. That endpoint is stateless: it reads and
// writes nothing, so it needs no auth — the request carries the sentence plus
// the device's clock and timezone, and the reply is a proposal this file turns
// into a pendingAction. The user confirms, and the write happens locally.
//
// When the server is unreachable, parsing falls back to the on-device rules
// below. They handle the common phrasings so the feature degrades instead of
// failing outright.

/** Where the parsing endpoint lives. */
const PARSE_URL = 'https://personal-assistant-api-production-618a.up.railway.app/parse';

type Proposal = {
  kind: 'task' | 'event' | 'clarify';
  title: string;
  startsAt?: string | null;
  endsAt?: string | null;
  dueAt?: string | null;
  notes?: string | null;
  priority?: 'Low' | 'Medium' | 'High' | null;
  message?: string | null;
};

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Words that signal a task rather than a calendar entry. */
const TASK_WORDS = /\b(remind|task|todo|to-do|remember|don'?t forget)\b/i;
/** Words that signal an appointment with a time. */
const EVENT_WORDS = /\b(meeting|meet|call|appointment|schedule|lunch|dinner|coffee|review|demo|sync|standup|interview)\b/i;

type Parsed = {
  title: string;
  /** Local Date for the start, or null when no date was found. */
  when: Date | null;
  /** True when the text named a clock time, not just a day. */
  hasTime: boolean;
};

/**
 * Pulls a date out of the text. Recognises today/tomorrow, weekday names
 * ("friday", "next friday"), and "in N days".
 */
function parseDay(text: string, base: Date): { date: Date | null; matched: string } {
  const t = text.toLowerCase();

  if (/\btoday\b/.test(t)) return { date: new Date(base), matched: 'today' };

  if (/\btomorrow\b/.test(t)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return { date: d, matched: 'tomorrow' };
  }

  const inDays = t.match(/\bin (\d+) days?\b/);
  if (inDays) {
    const d = new Date(base);
    d.setDate(d.getDate() + parseInt(inDays[1], 10));
    return { date: d, matched: inDays[0] };
  }

  for (let i = 0; i < WEEKDAYS.length; i++) {
    const name = WEEKDAYS[i];
    const re = new RegExp(`\\b(next\\s+)?${name}\\b`, 'i');
    const m = t.match(re);
    if (!m) continue;
    const d = new Date(base);
    // Always look forward: "friday" said on a Friday means the next one.
    let delta = (i - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (m[1]) delta += 7; // "next friday"
    d.setDate(d.getDate() + delta);
    return { date: d, matched: m[0] };
  }

  return { date: null, matched: '' };
}

/** Pulls a clock time: "3pm", "at 10", "10:30", "14:00". */
function parseTime(text: string): { h: number; m: number; matched: string } | null {
  const t = text.toLowerCase();

  // 3pm / 3 pm / 3:30pm
  const ampm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (ampm[3] === 'pm') h += 12;
    return { h, m: ampm[2] ? parseInt(ampm[2], 10) : 0, matched: ampm[0] };
  }

  // 24-hour, or "at 10"
  const plain = t.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/) || t.match(/\bat\s+(\d{1,2})\b/);
  if (plain) {
    const h = parseInt(plain[1], 10);
    const m = plain[2] ? parseInt(plain[2], 10) : 0;
    if (h < 24 && m < 60) {
      // A bare "at 8" almost always means the working day, not 08:00 at night.
      return { h, m, matched: plain[0] };
    }
  }

  return null;
}

/** Strips scheduling words so the title reads naturally. */
function cleanTitle(text: string, consumed: string[]): string {
  let out = text;
  for (const c of consumed) {
    if (c) out = out.replace(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  }
  out = out
    .replace(/\b(remind me to|remind me|please|can you|could you|i need to|i want to)\b/gi, ' ')
    .replace(/\b(add|create|schedule|set|make|book)\s+(a|an|the)?\s*(task|event|reminder|meeting)?\b/gi, ' ')
    .replace(/\b(on|at|for|this|next)\b\s*$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,\-–—:]+|[,\-–—:]+$/g, '')
    .trim();

  if (!out) return '';
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function parse(text: string, base = new Date()): Parsed {
  const day = parseDay(text, base);
  const time = parseTime(text);

  let when: Date | null = null;
  if (day.date || time) {
    when = day.date ? new Date(day.date) : new Date(base);
    if (time) {
      when.setHours(time.h, time.m, 0, 0);
      // A time already past today means they meant tomorrow.
      if (!day.date && when.getTime() < base.getTime()) {
        when.setDate(when.getDate() + 1);
      }
    } else {
      when.setHours(9, 0, 0, 0);
    }
  }

  return {
    title: cleanTitle(text, [day.matched, time?.matched ?? '']),
    when,
    hasTime: Boolean(time),
  };
}

const msg = (
  role: ChatMessage['role'],
  content: string,
  pendingAction: ChatMessage['pendingAction'] = null,
): ChatMessage => ({
  id: uuid(),
  role,
  content,
  toolCalls: null,
  toolCallId: null,
  pendingAction,
  createdAt: new Date().toISOString(),
});

function describe(when: Date, hasTime: boolean): string {
  const date = when.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  if (!hasTime) return date;
  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

/** Builds the reply messages from a server proposal. */
function fromProposal(p: Proposal): ChatMessage[] {
  if (p.kind === 'clarify' || !p.title) {
    return [
      msg(
        'assistant',
        p.message ||
          'What should I call it? For example: "Remind me to call the dentist tomorrow at 10".',
      ),
    ];
  }

  const notes = p.priority ? `[${p.priority}] ${p.notes ?? ''}`.trim() : (p.notes ?? undefined);

  if (p.kind === 'event' && p.startsAt) {
    return [
      msg('assistant', '', {
        tool: 'create_event',
        arguments: {
          title: p.title,
          startsAt: p.startsAt,
          endsAt:
            p.endsAt ??
            new Date(new Date(p.startsAt).getTime() + 60 * 60 * 1000).toISOString(),
          ...(notes ? { notes } : {}),
        },
      }),
    ];
  }

  return [
    msg('assistant', '', {
      tool: 'create_task',
      arguments: {
        title: p.title,
        ...(p.dueAt ? { dueAt: p.dueAt } : {}),
        ...(notes ? { notes } : {}),
      },
    }),
  ];
}

/**
 * Turns a user message into assistant replies. Tries the server first, since
 * it understands far more phrasings; falls back to the on-device rules when
 * the request fails, so the feature still works offline.
 */
export async function respondTo(text: string): Promise<ChatMessage[]> {
  try {
    // Short timeout: a slow parse should drop to the local rules rather than
    // leave the user watching a spinner.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(PARSE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          now: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const { proposal } = (await res.json()) as { proposal: Proposal };
        if (proposal) return fromProposal(proposal);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fall through to local parsing.
  }
  return respondLocally(text);
}

/** Rule-based fallback used when the server can't be reached. */
function respondLocally(text: string): ChatMessage[] {
  const { title, when, hasTime } = parse(text);

  if (!title) {
    return [
      msg(
        'assistant',
        'What should I call it? For example: "Remind me to call the dentist tomorrow at 10".',
      ),
    ];
  }

  // No date and no scheduling verb: an undated task is the safe reading.
  const wantsEvent = EVENT_WORDS.test(text) && !TASK_WORDS.test(text);

  if (wantsEvent && when) {
    return [
      msg('assistant', '', {
        tool: 'create_event',
        arguments: {
          title,
          startsAt: when.toISOString(),
          endsAt: new Date(when.getTime() + 60 * 60 * 1000).toISOString(),
        },
      }),
    ];
  }

  return [
    msg('assistant', '', {
      tool: 'create_task',
      arguments: {
        title,
        ...(when ? { dueAt: when.toISOString() } : {}),
      },
    }),
  ];
}

/** Confirmation line shown after the action runs. */
export function confirmationFor(
  tool: string,
  args: Record<string, unknown>,
): string {
  const title = typeof args.title === 'string' ? args.title : 'It';
  const iso = (args.startsAt ?? args.dueAt) as string | undefined;
  if (!iso) return `Added “${title}”.`;
  const d = new Date(iso);
  const kind = tool === 'create_event' ? 'Scheduled' : 'Added';
  return `${kind} “${title}” for ${describe(d, true)}.`;
}
