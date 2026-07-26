/**
 * Chat router (T4.4) — orchestrator only per CLAUDE.md §6.
 *
 * Endpoint: POST /chat/message
 *
 * Two modes:
 *   1. { text }               — user turn; runs the LLM loop.
 *   2. { confirmMessageId }   — confirms a previously proposed pending action.
 *
 * Invariants (CLAUDE.md §2.1–2.2):
 *   - Mutating tools NEVER execute during the LLM turn — they become a
 *     `pending_action` on the assistant message. The user must confirm.
 *   - Read-only tools (list_*) execute inline as part of the LLM loop.
 *   - Ownership is re-checked on every executor call — the LLM cannot bypass
 *     it by hallucinating an id.
 *   - Per-user mutex serialises all /chat/message calls (§8 concurrency).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@prisma/client';
import OpenAI from 'openai';

import { authMiddleware } from '../../middleware/auth.js';
import { chatLimiter } from '../../middleware/rateLimit.js';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { NotFound, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../db.js';

import { withUserLock } from './mutex.js';
import { getOpenAI, CHAT_MODEL } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import {
  TOOL_DEFINITIONS,
  isToolName,
  isReadOnlyTool,
  executeReadOnlyTool,
  executePendingAction,
  buildPendingAction,
  type PendingAction,
} from './tools.js';
import {
  saveUserMessage,
  saveAssistantMessage,
  saveToolMessage,
  getRecentHistory,
  clearPendingAction,
  findAssistantMessageWithPending,
  serializeChatMessage,
} from './persistence.js';

export const chatRouter = Router();

// ─── Body validation ────────────────────────────────────────────────────────

const messageBody = z
  .object({
    text: z.string().min(1).optional(),
    confirmMessageId: z.string().uuid().optional(),
  })
  .refine(
    (d) => Boolean(d.text) !== Boolean(d.confirmMessageId),
    { message: 'provide either `text` or `confirmMessageId`, not both' },
  );

// ─── Route handler ──────────────────────────────────────────────────────────

chatRouter.post(
  '/chat/message',
  authMiddleware,
  chatLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(messageBody, req);
    const user = req.user!;

    const newMessages = await withUserLock(user.id, async () => {
      if (body.confirmMessageId) {
        return handleConfirm(user.id, body.confirmMessageId);
      }
      return handleUserTurn(user, body.text!);
    });

    res.json({ messages: newMessages.map(serializeChatMessage) });
  }),
);

// ─── Confirmation flow ──────────────────────────────────────────────────────

async function handleConfirm(
  userId: string,
  confirmMessageId: string,
): Promise<ChatMessage[]> {
  const assistantRow = await findAssistantMessageWithPending(confirmMessageId, userId);
  if (!assistantRow) {
    throw new NotFound('No pending action to confirm');
  }

  const action = assistantRow.pendingAction as unknown as PendingAction & {
    toolCallId?: string;
  };

  const outcome = await executePendingAction(action, userId);
  await clearPendingAction(assistantRow.id);

  // Persist a tool-role message capturing the outcome so subsequent LLM
  // turns have it in context.
  const toolResultContent = JSON.stringify(outcome);
  const toolMsg = await saveToolMessage({
    userId,
    content: toolResultContent,
    toolCallId: action.toolCallId ?? assistantRow.id,
  });

  // Have the LLM narrate the result in the user's language.
  const closingAssistant = await runFollowUp(userId);

  return closingAssistant ? [toolMsg, closingAssistant] : [toolMsg];
}

// ─── User turn (LLM loop) ───────────────────────────────────────────────────

const MAX_READ_ONLY_LOOPS = 3;

async function handleUserTurn(
  user: { id: string; language: 'he' | 'en'; timezone: string },
  text: string,
): Promise<ChatMessage[]> {
  const userMsg = await saveUserMessage({ userId: user.id, content: text });
  const created: ChatMessage[] = [userMsg];

  const dbUser = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { name: true },
  });

  const systemPrompt = buildSystemPrompt({
    userName: dbUser.name,
    language: user.language,
    timezone: user.timezone,
    now: new Date(),
  });

  for (let loop = 0; loop <= MAX_READ_ONLY_LOOPS; loop++) {
    const history = await getRecentHistory(user.id);
    const messages = toOpenAIMessages(systemPrompt, history);

    const completion = await callLlm(messages);
    const choice = completion.choices[0];
    if (!choice) {
      throw new Error('LLM returned no choices');
    }
    const msg = choice.message;

    // 1. Text-only response → save + done.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const saved = await saveAssistantMessage({
        userId: user.id,
        content: msg.content ?? '',
      });
      created.push(saved);
      break;
    }

    // We only honour the first tool_call per turn (MVP simplicity).
    const toolCall = msg.tool_calls[0]!;
    if (toolCall.type !== 'function') {
      // Persist the assistant turn so it isn't lost from history, then bail.
      logger.warn({ type: toolCall.type }, 'LLM emitted non-function tool call');
      const savedAssistant = await saveAssistantMessage({
        userId: user.id,
        content: msg.content ?? '',
        toolCalls: msg.tool_calls,
      });
      created.push(savedAssistant);
      break;
    }
    const name = toolCall.function.name;

    if (!isToolName(name)) {
      // Model hallucinated an unknown tool. Save error tool message, loop back.
      logger.warn({ name }, 'LLM invoked unknown tool');
      const savedAssistant = await saveAssistantMessage({
        userId: user.id,
        content: msg.content ?? '',
        toolCalls: msg.tool_calls,
      });
      created.push(savedAssistant);
      const savedTool = await saveToolMessage({
        userId: user.id,
        content: JSON.stringify({ ok: false, code: 'VALIDATION_ERROR', message: `Unknown tool ${name}` }),
        toolCallId: toolCall.id,
      });
      created.push(savedTool);
      continue;
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(toolCall.function.arguments || '{}');
    } catch {
      rawArgs = {};
    }

    // 2. Mutating tool → save assistant with pendingAction; return the card.
    if (!isReadOnlyTool(name)) {
      let pending: PendingAction;
      try {
        pending = buildPendingAction(name, rawArgs);
      } catch (err) {
        logger.warn({ err, name }, 'LLM emitted invalid tool arguments');
        throw new ValidationError('LLM produced invalid tool arguments');
      }

      const saved = await saveAssistantMessage({
        userId: user.id,
        content: msg.content ?? '',
        toolCalls: msg.tool_calls,
        pendingAction: {
          ...pending,
          toolCallId: toolCall.id,
        },
      });
      created.push(saved);
      break;
    }

    // 3. Read-only tool → execute inline, feed result back to the LLM.
    const savedAssistant = await saveAssistantMessage({
      userId: user.id,
      content: msg.content ?? '',
      toolCalls: msg.tool_calls,
    });
    created.push(savedAssistant);

    let toolResult: string;
    try {
      toolResult = await executeReadOnlyTool(name, rawArgs, user.id);
    } catch (err) {
      logger.warn({ err, name }, 'read-only tool failed');
      toolResult = JSON.stringify({ ok: false, message: 'Tool execution failed' });
    }

    const savedTool = await saveToolMessage({
      userId: user.id,
      content: toolResult,
      toolCallId: toolCall.id,
    });
    created.push(savedTool);
    // fall through to next loop iteration
  }

  // Safety net (QA-1 M1 + M2): a "terminal" turn is either a plain text
  // assistant message (no tool_calls) or an assistant carrying a
  // pendingAction (confirmation card). Anything else means the loop
  // exhausted or bailed without giving the client something renderable —
  // save a fallback so we don't return a tool payload as the last item.
  const last = created[created.length - 1]!;
  const isTerminal =
    last.role === 'assistant' &&
    (last.pendingAction !== null || last.toolCalls === null);
  if (!isTerminal) {
    const fallback = await saveAssistantMessage({
      userId: user.id,
      content:
        user.language === 'he'
          ? 'לא הצלחתי להשלים את הבקשה בזמן. אפשר לנסות שוב?'
          : "I couldn't complete that in time — please try again.",
    });
    created.push(fallback);
  }

  return created;
}

// ─── Follow-up narration (after confirmed action) ──────────────────────────

async function runFollowUp(userId: string): Promise<ChatMessage | null> {
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, language: true, timezone: true },
  });
  if (!dbUser) return null;

  const systemPrompt = buildSystemPrompt({
    userName: dbUser.name,
    language: dbUser.language,
    timezone: dbUser.timezone,
    now: new Date(),
  });

  const history = await getRecentHistory(userId);
  const messages = toOpenAIMessages(systemPrompt, history);

  // In the follow-up we don't want the LLM to fire another tool_call —
  // just narrate. If it does, we ignore and save the text.
  const completion = await callLlm(messages, { tool_choice: 'none' });
  const choice = completion.choices[0];
  if (!choice) return null;

  return saveAssistantMessage({
    userId,
    content: choice.message.content ?? '',
  });
}

// ─── OpenAI helpers ─────────────────────────────────────────────────────────

function toOpenAIMessages(
  systemPrompt: string,
  history: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const base: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content || null,
      };
      if (m.toolCalls) {
        base.tool_calls = m.toolCalls as unknown as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
      }
      out.push(base);
    } else if (m.role === 'tool') {
      if (!m.toolCallId) continue; // shouldn't happen, but skip malformed
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }

  return out;
}

async function callLlm(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  overrides: Partial<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> = {},
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const client = getOpenAI();
  return client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto',
    ...overrides,
  });
}
