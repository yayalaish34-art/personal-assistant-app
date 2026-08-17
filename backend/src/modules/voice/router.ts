import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, parseBody, parseQuery } from '../../lib/http.js';
import { chatLimiter, speechLimiter } from '../../middleware/rateLimit.js';
import { ValidationError } from '../../lib/errors.js';
import { config } from '../../config.js';
import { runVoiceTurn, snapshotSchema, profileSchema } from './agent.js';
import { synthesize, isSpeechConfigured, MAX_SPEECH_CHARS } from './tts.js';

/**
 * The voice assistant (stateless).
 *
 * Like /parse, these routes are unauthenticated because they own no data: the
 * device stores the tasks and events, sends what the model needs, and applies
 * whatever comes back. What lives here is the part that cannot ship to a
 * device — the OpenAI and ElevenLabs keys. Rate limiting is what protects the
 * budget.
 */
export const voiceRouter = Router();

/**
 * A language, as an ISO-639-1 code.
 *
 * The shape is checked; the particular language is not. This used to be an
 * enum of the seven the app shipped with, which tied a list living in the
 * client to a server deploy: a device updated with a new interface language
 * would send a code the enum had never heard of, get a 400, and lose the whole
 * turn — not just the greeting the code was for. An unknown code now simply
 * greets in English (see `LANGUAGE_NAMES` in agent.ts).
 */
const languageCode = z
  .string()
  .regex(/^[a-z]{2}$/, 'Expected a two-letter ISO-639-1 language code');

const turnBody = z.object({
  /** What the user said, already transcribed. */
  text: z.string().min(1).max(2000),
  /**
   * The language of the opening greeting — the one turn with no user words to
   * mirror. Every real turn is answered in whatever language the user spoke.
   */
  language: languageCode.default('he'),
  timezone: z.string().min(1).max(64).default('UTC'),
  now: z.string().datetime().optional(),
  userName: z.string().max(80).optional(),
  /**
   * Earlier turns of this conversation, oldest first. The conversation is one
   * running thread rather than a series of one-shot requests, so this is how
   * "move that one too" reaches the model with something to point at.
   */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(2000),
      }),
    )
    .max(40)
    .default([]),
  snapshot: snapshotSchema.default({ tasks: [], events: [] }),
  /**
   * What the opening questionnaire learned. Optional on purpose: an install
   * from before it existed, or someone who skipped it, still gets a full turn
   * — just one tuned to nobody in particular.
   */
  profile: profileSchema.optional(),
});

// ── POST /voice/turn ────────────────────────────────────────────────────────

voiceRouter.post(
  '/voice/turn',
  chatLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(turnBody, req);

    if (!config.OPENAI_API_KEY) {
      throw new ValidationError('The assistant is not configured on this server');
    }

    const { reply, actions } = await runVoiceTurn({
      text: body.text,
      language: body.language,
      timezone: body.timezone,
      now: body.now ? new Date(body.now) : new Date(),
      userName: body.userName,
      history: body.history,
      snapshot: body.snapshot,
      profile: body.profile,
    });

    res.json({
      reply,
      actions,
      // The device only asks for audio when there is a voice to ask for.
      canSpeak: isSpeechConfigured(),
    });
  }),
);

// ── GET /voice/speak ────────────────────────────────────────────────────────
//
// A GET returning the audio itself, because that is what a media player can
// take: the device hands this URL straight to the player instead of buffering
// a response body it has nowhere to put.

// No `language` here on purpose. The reply's language follows the user's
// speech, so the device cannot know it, and the voice model is read off the
// text itself (see tts.ts). Zod ignores query keys a schema does not mention,
// so a client still sending `language=` is neither rejected nor listened to.
const speakQuery = z.object({
  text: z.string().min(1).max(MAX_SPEECH_CHARS),
});

voiceRouter.get(
  '/voice/speak',
  speechLimiter,
  asyncHandler(async (req, res) => {
    const { text } = parseQuery(speakQuery, req);

    const audio = await synthesize(text);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    // Same sentence, same bytes — let the player and any proxy keep it briefly.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).end(audio);
  }),
);
