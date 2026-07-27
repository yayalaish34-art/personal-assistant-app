import { Router } from 'express';
import type { Task, Event } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth.js';
import { prisma } from '../../db.js';
import { ValidationError } from '../../lib/errors.js';
import { asyncHandler } from '../../lib/http.js';
import { dayRangeInTz, rangeInTz } from './dateRange.js';

export const agendaRouter = Router();

// ─── Serializers ──────────────────────────────────────────────────────────────
// Local copies per instructions (T2.1 / T2.2 running in parallel).
// Orchestrator will DRY these up in Phase 2 wire-up if desired.

function serializeTask(t: Task) {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    isDone: t.isDone,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    deletedAt: t.deletedAt?.toISOString() ?? null,
  };
}

function serializeEvent(e: Event) {
  return {
    id: e.id,
    title: e.title,
    note: e.note ?? null,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    reminderMinutesBefore: e.reminderMinutesBefore ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    deletedAt: e.deletedAt?.toISOString() ?? null,
  };
}

// ─── Date string validation ────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime());
}

// ─── GET /agenda ──────────────────────────────────────────────────────────────

agendaRouter.get(
  '/agenda',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { date, from, to } = req.query as Record<string, string | undefined>;
    const user = req.user!;
    const tz = user.timezone;

    // Validate mutual exclusivity of query shapes
    const hasDate = date !== undefined;
    const hasFrom = from !== undefined;
    const hasTo = to !== undefined;

    if (!hasDate && !hasFrom && !hasTo) {
      throw new ValidationError(
        'provide either `date` or `from`+`to`',
      );
    }
    if (hasDate && (hasFrom || hasTo)) {
      throw new ValidationError(
        '`date` cannot be combined with `from` or `to`',
      );
    }
    if (hasDate) {
      // Single-day mode
      if (!isValidDateStr(date!)) {
        throw new ValidationError('`date` must be YYYY-MM-DD');
      }
    } else {
      // Range mode — both from and to are required
      if (!hasFrom || !hasTo) {
        throw new ValidationError(
          'provide both `from` and `to` when using range mode',
        );
      }
      if (!isValidDateStr(from!)) {
        throw new ValidationError('`from` must be YYYY-MM-DD');
      }
      if (!isValidDateStr(to!)) {
        throw new ValidationError('`to` must be YYYY-MM-DD');
      }
    }

    // Compute UTC window
    let windowStart: Date;
    let windowEnd: Date; // exclusive upper bound (start of next day)

    if (hasDate) {
      const range = dayRangeInTz(date!, tz);
      windowStart = range.start;
      windowEnd = range.end;
    } else {
      const range = rangeInTz(from!, to!, tz);
      windowStart = range.start;
      windowEnd = range.end;
    }

    const userId = user.id;

    // Fetch events whose [startsAt, endsAt) overlaps [windowStart, windowEnd)
    // Overlap condition: startsAt < windowEnd AND endsAt > windowStart
    const events = await prisma.event.findMany({
      where: {
        userId,
        deletedAt: null,
        startsAt: { lt: windowEnd },
        endsAt: { gt: windowStart },
      },
      orderBy: { startsAt: 'asc' },
    });

    // Fetch tasks whose dueAt falls within [windowStart, windowEnd)
    // Skip tasks with null dueAt
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        deletedAt: null,
        dueAt: {
          gte: windowStart,
          lt: windowEnd,
        },
      },
      orderBy: { dueAt: 'asc' },
    });

    res.json({
      events: events.map(serializeEvent),
      tasks: tasks.map(serializeTask),
    });
  }),
);
