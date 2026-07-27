/**
 * Rate-limit middleware (T4.5).
 *
 * Three named exports, each backed by express-rate-limit:
 *   - chatLimiter    30/min + 500/day, keyed on user id (falls back to IP)
 *   - speechLimiter  10/min, keyed on user id (falls back to IP)
 *   - authLimiter    20/min, keyed on IP
 *
 * On block, all three call next(new RateLimited(...)) so the central error
 * handler returns the API_CONTRACT.md error shape and sets Retry-After.
 */

import { rateLimit, ipKeyGenerator, type RateLimitExceededEventHandler } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { RateLimited } from '../lib/errors.js';

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
});

const chatDayLimiter: RequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  limit: 500,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: makeHandler('Chat daily rate limit exceeded'),
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
});

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
});
