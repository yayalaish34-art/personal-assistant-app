import type { ChatMessage } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';

// ─── Serializer ──────────────────────────────────────────────────────────────

/**
 * Converts a Prisma ChatMessage row into the API_CONTRACT.md "Message shape".
 * Preserves null where fields are null — does NOT convert to undefined.
 */
export function serializeChatMessage(m: ChatMessage) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? null,
    toolCallId: m.toolCallId ?? null,
    pendingAction: m.pendingAction ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

// ─── Save helpers ─────────────────────────────────────────────────────────────

/** Inserts a role:'user' message and returns the created row. */
export async function saveUserMessage({
  userId,
  content,
}: {
  userId: string;
  content: string;
}): Promise<ChatMessage> {
  return prisma.chatMessage.create({
    data: { userId, role: 'user', content },
  });
}

/** Inserts a role:'assistant' message and returns the created row. */
export async function saveAssistantMessage({
  userId,
  content,
  toolCalls,
  pendingAction,
}: {
  userId: string;
  content: string;
  toolCalls?: unknown;
  pendingAction?: unknown;
}): Promise<ChatMessage> {
  return prisma.chatMessage.create({
    data: {
      userId,
      role: 'assistant',
      content,
      toolCalls:
        toolCalls !== undefined
          ? (toolCalls as Prisma.InputJsonValue)
          : Prisma.DbNull,
      pendingAction:
        pendingAction !== undefined
          ? (pendingAction as Prisma.InputJsonValue)
          : Prisma.DbNull,
    },
  });
}

/** Inserts a role:'tool' message and returns the created row. */
export async function saveToolMessage({
  userId,
  content,
  toolCallId,
}: {
  userId: string;
  content: string;
  toolCallId: string;
}): Promise<ChatMessage> {
  return prisma.chatMessage.create({
    data: { userId, role: 'tool', content, toolCallId },
  });
}

// ─── History helpers ──────────────────────────────────────────────────────────

/**
 * Returns up to `limit` messages for the LLM context feed — **oldest first**.
 * This is NOT the paginated user-facing history; it is the array you pass to
 * the LLM on every turn.
 */
export async function getRecentHistory(
  userId: string,
  limit = 50,
): Promise<ChatMessage[]> {
  const cap = Math.min(limit, 50);

  // Fetch the N most-recent rows (newest first), then reverse for chronological order.
  const rows = await prisma.chatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: cap,
  });

  return rows.reverse();
}

// ─── Pending-action helpers ───────────────────────────────────────────────────

/**
 * Clears `pendingAction` on the given message row. Called after the action
 * has been confirmed and executed.
 */
export async function clearPendingAction(messageId: string): Promise<void> {
  await prisma.chatMessage.update({
    where: { id: messageId },
    data: { pendingAction: Prisma.DbNull },
  });
}

/**
 * Returns the ChatMessage if it belongs to `userId` AND still has a non-null
 * `pendingAction`. Returns null otherwise (not found, wrong user, or already
 * cleared).
 */
export async function findAssistantMessageWithPending(
  messageId: string,
  userId: string,
): Promise<ChatMessage | null> {
  const row = await prisma.chatMessage.findFirst({
    where: {
      id: messageId,
      userId,
      pendingAction: { not: Prisma.AnyNull },
    },
  });
  return row;
}
