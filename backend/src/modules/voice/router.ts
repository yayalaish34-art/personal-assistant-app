import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, parseBody, parseQuery } from '../../lib/http.js';
import { chatLimiter, speechLimiter } from '../../middleware/rateLimit.js';
import { ValidationError } from '../../lib/errors.js';
import { config } from '../../config.js';
import { runVoiceTurn, snapshotSchema } from './agent.js';
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

const LANGUAGES = ['he', 'en', 'ar', 'es', 'fr', 'it', 'ru'] as const;

const turnBody = z.object({
  /** What the user said, already transcribed. */
  text: z.string().min(1).max(2000),
  language: z.enum(LANGUAGES).default('en'),
  timezone: z.string().min(1).max(64).default('UTC'),
  now: z.string().datetime().optional(),
  userName: z.string().max(80).optional(),
  /** Earlier turns of this conversation, oldest first. */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(2000),
      }),
    )
    .max(20)
    .default([]),
  snapshot: snapshotSchema.default({ tasks: [], events: [] }),
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

const speakQuery = z.object({
  text: z.string().min(1).max(MAX_SPEECH_CHARS),
  language: z.enum(LANGUAGES).default('en'),
});

voiceRouter.get(
  '/voice/speak',
  speechLimiter,
  asyncHandler(async (req, res) => {
    const { text, language } = parseQuery(speakQuery, req);

    const audio = await synthesize(text, language);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    // Same sentence, same bytes — let the player and any proxy keep it briefly.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).end(audio);
  }),
);
