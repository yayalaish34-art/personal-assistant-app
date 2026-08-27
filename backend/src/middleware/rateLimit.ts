/**
 * Rate-limit middleware (T4.5).
 *
 * Named exports, each backed by express-rate-limit:
 *   - chatLimiter        30/min + 500/day, keyed on user id (falls back to IP)
 *   - speechLimiter      10/min, keyed on user id (falls back to IP)
 *   - voiceTurnLimiter   60/min + 500/day, for POST /voice/turn
 *   - voiceMediaLimiter  90/min + 1200/day, for /transcribe and /voice/speak
 *   - imageLimiter       4/min + 30/day
 *   - authLimiter        20/min, keyed on IP
 *
 * On block, all of them call next(new RateLimited(...)) so the central error
 * handler returns the API_CONTRACT.md error shape and sets Retry-After.
 *
 * Why voice has limiters of its own
 * --------------------------------
 * A spoken conversation is not one request, it is three: the recording goes to
 * /transcribe, the words go to /voice/turn, and the answer comes back through
 * /voice/speak. Those first and last used to share `speechLimiter` with its
 * budget of ten a minute, which sounds generous and is not — two of the ten
 * went on every exchange, so the sixth thing anyone said in a minute was
 * refused. Three refusals in a row is what the client counts before it stops
 * listening, so a conversation held at a normal pace died in under a minute
 * and could only be revived by leaving the screen and coming back.
 *
 * The numbers below are set from the other end: a brisk exchange takes about
 * five seconds, so a minute of talking without a pause is roughly twelve of
 * them. Sixty turns a minute leaves room for that, for the retries a flaky
 * connection adds, and for someone replaying a line they did not catch —
 * while the daily ceiling, which is what actually protects the bill, stays
 * where it was.
 */

import { rateLimit, ipKeyGenerator, type RateLimitExceededEventHandler } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { RateLimited } from '../lib/errors.js';
import { config } from '../config.js';

/**
 * The counters live in module memory and the whole suite runs in one fork from
 * one address, so every test file draws on the same bucket: the tests that
 * happen to run last get a 429 that has nothing to do with what they assert.
 * No test covers the 429 path, so nothing is lost by standing the limiters
 * down under NODE_ENV=test — and the enum in config.ts keeps that value out of
 * production.
 */
const disabledForTests = (): boolean => config.NODE_ENV === 'test';

// ---------------------------------------------------------------------------
// Helper — shared handler factory
// ---------------------------------------------------------------------------

/**
 * Builds the handler called when a client exceeds the limit.
 * Derives retryAfterSeconds from req.rateLimit.resetTime (set by
 * express-rate-limit before the handler runs) and forwards the error to the
 * central error handler via next().
 */
function makeHandler(message: string): RateLimitExceededEventHandler {
  return (req, _res, next) => {
    const info = (req as unknown as { rateLimit?: { resetTime?: Date } }).rateLimit;

    let retryAfterSeconds: number | undefined;
    if (info?.resetTime) {
      const msRemaining = info.resetTime.getTime() - Date.now();
      retryAfterSeconds = Math.ceil(Math.max(msRemaining, 0) / 1000);
    }

    next(new RateLimited(message, retryAfterSeconds));
  };
}

// ---------------------------------------------------------------------------
// Key generators
// ---------------------------------------------------------------------------

/** Per-user key; falls back to IP (via ipKeyGenerator for IPv6 safety) if authMiddleware hasn't run yet. */
function userKey(req: import('express').Request, _res: import('express').Response): string {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${ipKeyGenerator(req.ip ?? '127.0.0.1')}`;
}

// ---------------------------------------------------------------------------
// chatLimiter — 30 req/min AND 500 req/day, per user id
// ---------------------------------------------------------------------------

const chatMinuteLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,          // 1 minute
  limit: 30,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator is called inside userKey — suppress the validation warning
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Chat rate limit exceeded'),
  skip: disabledForTests,
});

const chatDayLimiter: RequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  limit: 500,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Chat daily rate limit exceeded'),
  skip: disabledForTests,
});

/**
 * chatLimiter — apply to POST /chat/message (after authMiddleware).
 * Chains the per-minute limiter then the per-day limiter; if either fires,
 * next(RateLimited) is called and the chain stops.
 */
export const chatLimiter: RequestHandler[] = [chatMinuteLimiter, chatDayLimiter];

// ---------------------------------------------------------------------------
// speechLimiter — 10 req/min, per user id
// ---------------------------------------------------------------------------

/**
 * speechLimiter — apply to POST /speech/transcribe (after authMiddleware).
 */
export const speechLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 10,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Speech rate limit exceeded'),
  skip: disabledForTests,
});

// ---------------------------------------------------------------------------
// voiceLimiters — the conversational path
// ---------------------------------------------------------------------------
//
// Keyed the same way as everything else, which for these routes means by IP:
// /voice/turn, /transcribe and /voice/speak are unauthenticated by design (the
// device owns the data, the server owns the keys), so `req.user` is never set
// and `userKey` falls back. That matters for the numbers: behind carrier NAT
// or one office router, several people can share a bucket, and a limit tuned
// to exactly one talker would cut off the second.

const voiceTurnMinuteLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Voice rate limit exceeded'),
  skip: disabledForTests,
});

/**
 * The turn is the unit the bill is counted in — one model call, or two when a
 * tool runs — so the daily ceiling lives here rather than being spread across
 * the three routes an exchange touches.
 */
const voiceTurnDayLimiter: RequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 500,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Voice daily rate limit exceeded'),
  skip: disabledForTests,
});

/** voiceTurnLimiter — apply to POST /voice/turn. */
export const voiceTurnLimiter: RequestHandler[] = [voiceTurnMinuteLimiter, voiceTurnDayLimiter];

const voiceMediaMinuteLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  // Half again as much as the turns themselves: transcribing and speaking are
  // one call each per exchange, and the audio is the part a dropped connection
  // makes the client ask for twice.
  limit: 90,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Voice rate limit exceeded'),
  skip: disabledForTests,
});

const voiceMediaDayLimiter: RequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  // Roughly two per turn against the daily ceiling above, so this backstops
  // abuse of the audio routes on their own without ever being what stops a
  // conversation that the turn limit would have allowed.
  limit: 1200,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Voice daily rate limit exceeded'),
  skip: disabledForTests,
});

/** voiceMediaLimiter — apply to POST /transcribe and GET /voice/speak. */
export const voiceMediaLimiter: RequestHandler[] = [
  voiceMediaMinuteLimiter,
  voiceMediaDayLimiter,
];

// ---------------------------------------------------------------------------
// imageLimiter — 4 req/min AND 30 req/day
// ---------------------------------------------------------------------------
//
// Tighter than anything else here, because a generated image costs orders of
// magnitude more than a chat turn and takes long enough that a user tapping
// twice is far more likely than a user genuinely wanting two.

const imageMinuteLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 4,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Image rate limit exceeded'),
  skip: disabledForTests,
});

const imageDayLimiter: RequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 30,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Image daily rate limit exceeded'),
  skip: disabledForTests,
});

/** imageLimiter — apply to POST /image. */
export const imageLimiter: RequestHandler[] = [imageMinuteLimiter, imageDayLimiter];

// ---------------------------------------------------------------------------
// authLimiter — 20 req/min, per IP
// ---------------------------------------------------------------------------

/**
 * authLimiter — apply to all /auth/* routes (before authMiddleware).
 */
export const authLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20,
  // Use ipKeyGenerator for correct IPv6 subnet handling
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? '127.0.0.1'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('Too many authentication requests'),
  skip: disabledForTests,
});
