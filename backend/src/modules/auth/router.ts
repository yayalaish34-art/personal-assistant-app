import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  rotateRefreshToken,
  revokeRefreshToken,
  signAccessToken,
} from '../../lib/tokens.js';
import { ValidationError } from '../../lib/errors.js';
import { prisma } from '../../db.js';
import { authMiddleware } from '../../middleware/auth.js';
import { signInFromIdentity } from './service.js';
import { verifyGoogleIdToken } from './providers/google.js';
import { verifyAppleIdToken } from './providers/apple.js';

const idTokenBody = z.object({
  idToken: z.string().min(1),
  timezone: z.string().min(1).default('UTC'),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1),
});

const logoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  pushToken: z.string().min(1).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('Invalid request body', { issues: result.error.issues });
  }
  return result.data;
}

const asyncHandler =
  <T = unknown>(fn: (req: Request, res: Response) => Promise<T>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export const authRouter = Router();

authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken, timezone } = parse(idTokenBody, req.body);
    const identity = await verifyGoogleIdToken(idToken);
    const result = await signInFromIdentity(identity, timezone);
    res.status(200).json(result);
  }),
);

authRouter.post(
  '/apple',
  asyncHandler(async (req, res) => {
    const { idToken, timezone } = parse(idTokenBody, req.body);
    const identity = await verifyAppleIdToken(idToken);
    const result = await signInFromIdentity(identity, timezone);
    res.status(200).json(result);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = parse(refreshBody, req.body);
    const { userId, refreshToken: newRefresh } = await rotateRefreshToken(refreshToken);
    const accessToken = signAccessToken(userId);
    res.status(200).json({ accessToken, refreshToken: newRefresh });
  }),
);

authRouter.post(
  '/logout',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = parse(logoutBody, req.body ?? {});
    const userId = req.user!.id;

    // Both operations must be scoped to the caller. Before authMiddleware was
    // added, anyone knowing a push token could deregister another user's
    // device. (Found in QA-2 as BLOCKER B-1.)
    await prisma.$transaction(async (tx) => {
      if (body.refreshToken) {
        await revokeRefreshToken(body.refreshToken, userId, tx);
      }
      if (body.pushToken) {
        await tx.device.deleteMany({
          where: { pushToken: body.pushToken, userId },
        });
      }
    });

    res.status(204).send();
  }),
);
