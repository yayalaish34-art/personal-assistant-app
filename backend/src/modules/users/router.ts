import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.js';
import { prisma } from '../../db.js';
import { ValidationError, NotFound } from '../../lib/errors.js';
import { toPublicUser } from '../auth/service.js';

export const usersRouter = Router();

// ─── GET /me ─────────────────────────────────────────────────────────────────

usersRouter.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.user!.id, deletedAt: null },
    });
    if (!user) {
      return next(new NotFound('User not found'));
    }
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /me ───────────────────────────────────────────────────────────────

const patchMeSchema = z.object({
  name: z.string().min(1).optional(),
  language: z.enum(['he', 'en']).optional(),
  timezone: z.string().min(1).optional(),
});

usersRouter.patch('/me', authMiddleware, async (req, res, next) => {
  try {
    const parsed = patchMeSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(new ValidationError('Invalid request body'));
    }

    const { name, language, timezone } = parsed.data;
    if (name === undefined && language === undefined && timezone === undefined) {
      return next(new ValidationError('No fields to update'));
    }

    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(name !== undefined && { name }),
        ...(language !== undefined && { language }),
        ...(timezone !== undefined && { timezone }),
      },
    });

    res.json({ user: toPublicUser(updated) });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /me ──────────────────────────────────────────────────────────────

usersRouter.delete('/me', authMiddleware, async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: req.user!.id, deletedAt: null },
      select: { deletionRequestedAt: true },
    });

    if (!existing) {
      return next(new NotFound('User not found'));
    }

    // Idempotent: if already set, return the existing timestamp without overwriting
    if (existing.deletionRequestedAt !== null) {
      return res
        .status(202)
        .json({ deletionRequestedAt: existing.deletionRequestedAt.toISOString() });
    }

    // TOCTOU fix (QA-2 M-1): mark deletion AND revoke refresh tokens in
    // a single transaction so a concurrent /auth/refresh can't slip a new
    // session in between.
    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user!.id },
        data: { deletionRequestedAt: now },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: req.user!.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    res.status(202).json({ deletionRequestedAt: now.toISOString() });
  } catch (err) {
    next(err);
  }
});
