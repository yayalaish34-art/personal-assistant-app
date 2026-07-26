import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Wraps an async Express handler so thrown errors reach the error middleware.
 * Use for any route that awaits.
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/**
 * Parse body / query / params with a Zod schema. Throws ValidationError on failure
 * so the error middleware emits the API_CONTRACT.md shape.
 */
export function parse<T>(schema: z.ZodType<T>, input: unknown, label = 'request'): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid ${label}`, { issues: result.error.issues });
  }
  return result.data;
}

/**
 * Shortcut for `parse(schema, req.body)`.
 */
export function parseBody<T>(schema: z.ZodType<T>, req: Request): T {
  return parse(schema, req.body ?? {}, 'body');
}

/**
 * Shortcut for `parse(schema, req.query)`.
 */
export function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  return parse(schema, req.query, 'query');
}
