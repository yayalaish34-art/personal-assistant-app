import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { config } from '../../config.js';
import { ValidationError } from '../../lib/errors.js';
import { chatLimiter } from '../../middleware/rateLimit.js';
import { getOpenAI, CHAT_MODEL } from './llm.js';

export const parseRouter = Router();

/**
 * POST /parse — turn a sentence into a proposed task or event.
 *
 * This is the stateless counterpart to /chat/message. That endpoint runs the
 * full tool loop and writes to the database; this one only interprets language
 * and hands the result back, because the client now stores its own data.
 *
 * No auth: there is nothing user-scoped here. Nothing is read or written — the
 * request carries everything the model needs, and the response is a proposal
 * the client applies locally. Rate limiting is what protects the API budget.
 *
 * The OpenAI key stays on the server; the device never sees it.
 */

const bodySchema = z.object({
  text: z.string().min(1).max(1000),
  /** IANA name, e.g. "Asia/Jerusalem". Relative dates are meaningless without it. */
  timezone: z.string().min(1).max(64).default('UTC'),
  /** Client's clock, so "tomorrow" resolves against the user's day, not the server's. */
  now: z.string().datetime().optional(),
});

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Strict mode requires every property to be listed here; optionality is
  // expressed by allowing null in the type instead.
  required: [
    'kind',
    'title',
    'startsAt',
    'endsAt',
    'dueAt',
    'notes',
    'priority',
    'message',
  ],
  properties: {
    kind: {
      type: 'string',
      enum: ['task', 'event', 'clarify'],
      description:
        'event when it happens at a set time with others; task when it is something to do; clarify when the request is too vague to act on.',
    },
    title: {
      type: 'string',
      description: 'Short imperative title, without dates or filler words.',
    },
    startsAt: {
      type: ['string', 'null'],
      description: 'ISO-8601 with offset, for kind=event.',
    },
    endsAt: {
      type: ['string', 'null'],
      description: 'ISO-8601 with offset. Defaults to one hour after startsAt.',
    },
    dueAt: {
      type: ['string', 'null'],
      description: 'ISO-8601 with offset, for kind=task. Null when undated.',
    },
    notes: { type: ['string', 'null'] },
    priority: { type: ['string', 'null'], enum: ['Low', 'Medium', 'High', null] },
    message: {
      type: ['string', 'null'],
      description: 'For kind=clarify: what to ask the user.',
    },
  },
} as const;

parseRouter.post(
  '/parse',
  chatLimiter,
  asyncHandler(async (req, res) => {
    const { text, timezone, now } = parseBody(bodySchema, req);

    if (!config.OPENAI_API_KEY) {
      throw new ValidationError('The assistant is not configured on this server');
    }

    // The model cannot resolve "tomorrow" without knowing the user's current
    // date, time, and zone — it will otherwise invent one.
    const reference = now ? new Date(now) : new Date();
    const localNow = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(reference);

    const client = getOpenAI();
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You convert a short request into a single calendar event or task.',
            `The user's local time is ${localNow} (${timezone}).`,
            'Resolve relative dates ("tomorrow", "next Friday", "in 3 days") against that.',
            'Always return times as ISO-8601 with an explicit offset.',
            'An event has a start time; a task may be undated.',
            'Strip dates and filler from the title — "Call the dentist", not',
            '"remind me to call the dentist tomorrow".',
            'If the request has no actionable subject, return kind=clarify with a',
            'short question in `message`.',
          ].join(' '),
        },
        { role: 'user', content: text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'proposal', strict: true, schema: PROPOSAL_SCHEMA },
      },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new ValidationError('The assistant returned an empty response');

    let proposal: unknown;
    try {
      proposal = JSON.parse(raw);
    } catch {
      throw new ValidationError('The assistant returned malformed output');
    }

    res.json({ proposal });
  }),
);
