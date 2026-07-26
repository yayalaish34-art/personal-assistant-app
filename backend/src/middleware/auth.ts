import type { Request, Response, NextFunction } from 'express';
import type { Language } from '@prisma/client';
import { verifyAccessToken } from '../lib/tokens.js';
import { Unauthorized } from '../lib/errors.js';
import { prisma } from '../db.js';

export interface AuthUser {
  id: string;
  timezone: string;
  language: Language;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/**
 * Verifies Bearer access token → attaches req.user.
 * Also refuses tokens for users that are soft-deleted.
 * We accept users with deletion_requested_at set (undo flow — signing back in
 * clears it — is handled by /auth/google|apple, not here).
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new Unauthorized('Missing bearer token'));
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return next(new Unauthorized('Missing bearer token'));
  }

  try {
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: { id: true, timezone: true, language: true },
    });
    if (!user) {
      return next(new Unauthorized('User not found'));
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
