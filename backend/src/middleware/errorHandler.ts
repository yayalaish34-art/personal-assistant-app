import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import pinoHttp from 'pino-http';
import { logger } from '../lib/logger.js';
import { isAppError, NotFound, RateLimited } from '../lib/errors.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// HTTP request logger (exported for use in app.ts)
// ---------------------------------------------------------------------------

export const httpLogger = pinoHttp({
  logger,
  redact: ['req.headers.authorization'],
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
  // In dev, suppress routine 2xx noise when pretty-printing
  customSuccessMessage:
    config.NODE_ENV === 'development'
      ? (req, res) => `${req.method} ${req.url} → ${res.statusCode}`
      : undefined,
});

// ---------------------------------------------------------------------------
// 404 handler — wire before errorHandler in app.ts
// ---------------------------------------------------------------------------

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new NotFound('Route not found'));
}

// ---------------------------------------------------------------------------
// Central error handler
// ---------------------------------------------------------------------------

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // 1. Known application errors
  if (isAppError(err)) {
    if (err instanceof RateLimited && err.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? {},
      },
    });
    return;
  }

  // 2. Zod validation errors (thrown directly from route handlers)
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { issues: err.issues },
      },
    });
    return;
  }

  // 3. Unexpected errors
  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');

  const message =
    config.NODE_ENV === 'production' ? 'Internal error' : (err instanceof Error ? err.message : 'Internal error');

  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: config.NODE_ENV === 'production' ? 'Internal error' : message,
    },
  });
}
