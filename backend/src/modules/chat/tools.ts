import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Task, Event } from '@prisma/client';
import { prisma } from '../../db.js';
import { logger } from '../../lib/logger.js';
import { scheduleEventReminder, cancelEventReminder } from '../events/reminders.js';

// ─── LLM-facing tool definitions ────────────────────────────────────────────
// OpenAI function-calling format. Field naming matches SPEC §5 (snake_case).

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description:
        'Propose creating a new task for the user. Requires user confirmation before it is saved.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1 },
          due_at: {
            type: 'string',
            description: 'Optional ISO-8601 UTC datetime for when the task is due.',
          },
          notes: { type: 'string', description: 'Optional free-form notes.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description:
        'Propose updating an existing task. Requires user confirmation. Only ids the user has referenced or ids returned by list_tasks may be used.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1 },
          due_at: { type: 'string', description: 'ISO-8601 UTC datetime, or null to clear.' },
          notes: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'complete_task',
      description:
        'Propose marking a task as done. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_tasks',
      description:
        "Read-only: list the user's tasks in a range. Executes immediately (no confirmation).",
      parameters: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            enum: ['today', 'week', 'overdue', 'all'],
          },
        },
        required: ['range'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_event',
      description:
        'Propose creating a new calendar event. Requires user confirmation. If ends_at is omitted the server defaults to 60 minutes after starts_at.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1 },
          starts_at: { type: 'string', description: 'ISO-8601 UTC datetime.' },
          ends_at: { type: 'string', description: 'ISO-8601 UTC datetime. Optional.' },
          note: { type: 'string' },
          reminder_minutes_before: {
            type: 'integer',
            description: 'Minutes before starts_at for a reminder. Null disables.',
            nullable: true,
          },
        },
        required: ['title', 'starts_at'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_events',
      description:
        "Read-only: list events in a time range. Executes immediately (no confirmation).",
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ISO-8601 UTC datetime, inclusive start.' },
          to: { type: 'string', description: 'ISO-8601 UTC datetime, inclusive end.' },
        },
        required: ['from', 'to'],
      },
    },
  },
];

// ─── Zod validation for arguments coming from the LLM ──────────────────────
// The LLM will send JSON; validate before we trust anything.

const dateStringOrNull = z.union([z.string().datetime(), z.null()]);

const createTaskArgs = z.object({
  title: z.string().min(1),
  due_at: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const updateTaskArgs = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).optional(),
  due_at: dateStringOrNull.optional(),
  notes: z.string().optional(),
});

const completeTaskArgs = z.object({
  id: z.string().uuid(),
});

const listTasksArgs = z.object({
  range: z.enum(['today', 'week', 'overdue', 'all']),
});

const createEventArgs = z.object({
  title: z.string().min(1),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime().optional(),
  note: z.string().optional(),
  reminder_minutes_before: z.number().int().nullable().optional(),
});

const listEventsArgs = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

const ARG_SCHEMAS = {
  create_task: createTaskArgs,
  update_task: updateTaskArgs,
  complete_task: completeTaskArgs,
  list_tasks: listTasksArgs,
  create_event: createEventArgs,
  list_events: listEventsArgs,
} as const;

export type ToolName = keyof typeof ARG_SCHEMAS;

export function isToolName(name: string): name is ToolName {
  return name in ARG_SCHEMAS;
}

const READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set(['list_tasks', 'list_events']);

export function isReadOnlyTool(name: ToolName): boolean {
  return READ_ONLY_TOOLS.has(name);
}

// ─── Pending action shape (persisted on ChatMessage.pendingAction) ─────────

export interface PendingAction {
  tool: ToolName;
  arguments: Record<string, unknown>;
}

/**
 * Parse & validate raw args from the LLM. Throws ZodError if invalid — the
 * caller (chat router) should convert that to a tool-error message the LLM
 * can retry against.
 */
export function parseArgs<T extends ToolName>(
  name: T,
  raw: unknown,
): z.infer<(typeof ARG_SCHEMAS)[T]> {
  const schema = ARG_SCHEMAS[name] as z.ZodType;
  return schema.parse(raw) as z.infer<(typeof ARG_SCHEMAS)[T]>;
}

// ─── Read-only executors (fire immediately during the LLM turn) ────────────

export async function executeReadOnlyTool(
  name: ToolName,
  rawArgs: unknown,
  userId: string,
): Promise<string> {
  const args = parseArgs(name, rawArgs);

  switch (name) {
    case 'list_tasks':
      return listTasks((args as z.infer<typeof listTasksArgs>).range, userId);
    case 'list_events': {
      const a = args as z.infer<typeof listEventsArgs>;
      return listEvents(a.from, a.to, userId);
    }
    default:
      throw new Error(`Not a read-only tool: ${name}`);
  }
}

async function listTasks(
  range: 'today' | 'week' | 'overdue' | 'all',
  userId: string,
): Promise<string> {
  const now = new Date();
  let where: Record<string, unknown> = { userId, deletedAt: null };

  if (range === 'today') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    where = { ...where, dueAt: { gte: start, lt: end } };
  } else if (range === 'week') {
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() + 7);
    where = { ...where, dueAt: { gte: now, lt: end } };
  } else if (range === 'overdue') {
    where = { ...where, dueAt: { lt: now }, isDone: false };
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { dueAt: 'asc' },
    take: 50,
  });

  return JSON.stringify(
    tasks.map((t) => ({
      id: t.id,
      title: t.title,
      due_at: t.dueAt?.toISOString() ?? null,
      is_done: t.isDone,
      notes: t.notes ?? null,
    })),
  );
}

async function listEvents(from: string, to: string, userId: string): Promise<string> {
  const fromDate = new Date(from);
  const toDate = new Date(to);

  const events = await prisma.event.findMany({
    where: {
      userId,
      deletedAt: null,
      // overlap semantics: event overlaps [from,to] if startsAt < to AND endsAt > from
      startsAt: { lt: toDate },
      endsAt: { gt: fromDate },
    },
    orderBy: { startsAt: 'asc' },
    take: 50,
  });

  return JSON.stringify(
    events.map((e) => ({
      id: e.id,
      title: e.title,
      starts_at: e.startsAt.toISOString(),
      ends_at: e.endsAt.toISOString(),
      note: e.note ?? null,
      reminder_minutes_before: e.reminderMinutesBefore,
    })),
  );
}

// ─── Pending action builder (for mutating tools) ───────────────────────────

/**
 * Validate raw LLM args and produce a PendingAction that will be stored on
 * the assistant message and executed after user confirmation.
 */
export function buildPendingAction(name: ToolName, rawArgs: unknown): PendingAction {
  if (isReadOnlyTool(name)) {
    throw new Error(`Tool ${name} is read-only; do not build a pending action for it`);
  }
  const args = parseArgs(name, rawArgs);
  return { tool: name, arguments: args as Record<string, unknown> };
}

// ─── Execute a confirmed pending action ────────────────────────────────────
// CRITICAL: every mutation goes through here; every mutation asserts
// ownership. See CLAUDE.md §2.2.

export interface ExecutionSuccess {
  ok: true;
  result: Task | Event | { message: string };
}
export interface ExecutionFailure {
  ok: false;
  code: 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'INTERNAL';
  message: string;
}
export type ExecutionOutcome = ExecutionSuccess | ExecutionFailure;

export async function executePendingAction(
  action: PendingAction,
  userId: string,
): Promise<ExecutionOutcome> {
  if (!isToolName(action.tool)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `Unknown tool: ${action.tool}` };
  }

  try {
    // Re-validate (defence in depth — the JSON in the DB may have drifted from
    // the schema if the code changed since the pending was created).
    const args = parseArgs(action.tool, action.arguments);

    switch (action.tool) {
      case 'create_task':
        return await execCreateTask(args as z.infer<typeof createTaskArgs>, userId);
      case 'update_task':
        return await execUpdateTask(args as z.infer<typeof updateTaskArgs>, userId);
      case 'complete_task':
        return await execCompleteTask(args as z.infer<typeof completeTaskArgs>, userId);
      case 'create_event':
        return await execCreateEvent(args as z.infer<typeof createEventArgs>, userId);
      default:
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Tool ${action.tool} is read-only; cannot execute as pending action`,
        };
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Invalid arguments: ${JSON.stringify(err.issues)}`,
      };
    }
    logger.error({ err, action }, 'tool execution failed');
    return { ok: false, code: 'INTERNAL', message: 'Execution failed' };
  }
}

// ─── Mutation executors ────────────────────────────────────────────────────

async function execCreateTask(
  args: z.infer<typeof createTaskArgs>,
  userId: string,
): Promise<ExecutionSuccess> {
  const task = await prisma.task.create({
    data: {
      id: randomUUID(),
      userId,
      title: args.title,
      notes: args.notes ?? null,
      dueAt: args.due_at ? new Date(args.due_at) : null,
    },
  });
  return { ok: true, result: task };
}

async function execUpdateTask(
  args: z.infer<typeof updateTaskArgs>,
  userId: string,
): Promise<ExecutionOutcome> {
  const existing = await prisma.task.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== userId || existing.deletedAt) {
    return { ok: false, code: 'NOT_FOUND', message: 'Task not found' };
  }

  const task = await prisma.task.update({
    where: { id: args.id },
    data: {
      ...(args.title !== undefined && { title: args.title }),
      ...(args.due_at !== undefined && { dueAt: args.due_at === null ? null : new Date(args.due_at) }),
      ...(args.notes !== undefined && { notes: args.notes }),
    },
  });
  return { ok: true, result: task };
}

async function execCompleteTask(
  args: z.infer<typeof completeTaskArgs>,
  userId: string,
): Promise<ExecutionOutcome> {
  const existing = await prisma.task.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== userId || existing.deletedAt) {
    return { ok: false, code: 'NOT_FOUND', message: 'Task not found' };
  }
  const task = await prisma.task.update({
    where: { id: args.id },
    data: { isDone: true },
  });
  return { ok: true, result: task };
}

async function execCreateEvent(
  args: z.infer<typeof createEventArgs>,
  userId: string,
): Promise<ExecutionOutcome> {
  const startsAt = new Date(args.starts_at);
  const endsAt = args.ends_at
    ? new Date(args.ends_at)
    : new Date(startsAt.getTime() + 60 * 60 * 1000);

  if (endsAt <= startsAt) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'ends_at must be after starts_at' };
  }

  const event = await prisma.event.create({
    data: {
      id: randomUUID(),
      userId,
      title: args.title,
      note: args.note ?? null,
      startsAt,
      endsAt,
      reminderMinutesBefore: args.reminder_minutes_before ?? null,
    },
  });

  await scheduleEventReminder(event);

  return { ok: true, result: event };
}

// Re-export for router use — keeps the import surface small.
export { cancelEventReminder };
