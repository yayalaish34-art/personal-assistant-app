import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.js';
import { prisma } from '../../db.js';
import { asyncHandler, parseQuery } from '../../lib/http.js';
import { serializeChatMessage } from './persistence.js';

export const chatHistoryRouter = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const historyQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ─── GET /chat/history?cursor=<messageId>&limit=<n> ──────────────────────────

chatHistoryRouter.get(
  '/chat/history',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { cursor, limit } = parseQuery(historyQuerySchema, req);
    const userId = req.user!.id;

    // Resolve cursor → a createdAt boundary, scoped to this user.
    let cursorCreatedAt: Date | undefined;
    if (cursor !== undefined) {
      const cursorRow = await prisma.chatMessage.findFirst({
        where: { id: cursor, userId },
        select: { createdAt: true },
      });
      // If cursor id not found or belongs to another user, treat as no cursor.
      if (cursorRow) {
        cursorCreatedAt = cursorRow.createdAt;
      }
    }

    // Fetch messages older than the cursor (or all messages if no cursor),
    // newest first, capped at `limit`.
    const messages = await prisma.chatMessage.findMany({
      where: {
        userId,
        ...(cursorCreatedAt !== undefined
          ? { createdAt: { lt: cursorCreatedAt } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // nextCursor = id of the oldest message returned, but only if a full page
    // was returned (indicating there may be more).
    const nextCursor =
      messages.length === limit
        ? (messages[messages.length - 1]?.id ?? null)
        : null;

    res.json({
      messages: messages.map(serializeChatMessage),
      nextCursor,
    });
  }),
);
