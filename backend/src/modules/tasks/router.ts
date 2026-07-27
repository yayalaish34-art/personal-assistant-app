import { Router } from 'express';
import { z } from 'zod';
import type { Task } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth.js';
import { prisma } from '../../db.js';
import { NotFound, Conflict, ValidationError } from '../../lib/errors.js';
import { asyncHandler, parseBody, parseQuery } from '../../lib/http.js';

export const tasksRouter = Router();

// ─── Serializer ──────────────────────────────────────────────────────────────

export function serializeTask(t: Task) {
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

// ─── Schemas ─────────────────────────────────────────────────────────────────

const getTasksQuerySchema = z.object({
  updatedSince: z.string().datetime().optional(),
});

const createTaskBodySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  notes: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const patchTaskBodySchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  isDone: z.boolean().optional(),
  updatedAt: z.string().datetime().optional(),
});

// ─── GET /tasks?updatedSince=<ISO> ───────────────────────────────────────────

tasksRouter.get(
  '/tasks',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const query = parseQuery(getTasksQuerySchema, req);
    const userId = req.user!.id;

    let updatedSinceDate: Date | undefined;
    if (query.updatedSince) {
      updatedSinceDate = new Date(query.updatedSince);
    }

    const tasks = await prisma.task.findMany({
      where: {
        userId,
        ...(updatedSinceDate
          ? { updatedAt: { gte: updatedSinceDate } }
          : { deletedAt: null }),
      },
      orderBy: { updatedAt: 'asc' },
    });

    res.json({
      tasks: tasks.map(serializeTask),
      serverTime: new Date().toISOString(),
    });
  }),
);

// ─── POST /tasks ─────────────────────────────────────────────────────────────

tasksRouter.post(
  '/tasks',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = parseBody(createTaskBodySchema, req);
    const userId = req.user!.id;

    // Check for existing task with the same id
    const existing = await prisma.task.findUnique({
      where: { id: body.id },
    });

    if (existing) {
      if (existing.userId !== userId) {
        throw new Conflict('Id belongs to another user');
      }
      // Idempotent replay — return existing row as-is
      return res.status(200).json(serializeTask(existing));
    }

    // Create new task
    const task = await prisma.task.create({
      data: {
        id: body.id,
        userId,
        title: body.title,
        notes: body.notes ?? null,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        // Honor the client's updatedAt so offline creations preserve their
        // original timestamp for LWW sync. Prisma's @updatedAt would otherwise
        // stamp server-now, breaking API_CONTRACT sync summary §5.
        ...(body.updatedAt ? { updatedAt: new Date(body.updatedAt) } : {}),
      },
    });

    return res.status(201).json(serializeTask(task));
  }),
);

// ─── PATCH /tasks/:id ────────────────────────────────────────────────────────

tasksRouter.patch(
  '/tasks/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = parseBody(patchTaskBodySchema, req);
    const { id } = req.params as { id: string };
    const userId = req.user!.id;

    // Reject empty body
    const { title, notes, dueAt, isDone } = body;
    if (
      title === undefined &&
      notes === undefined &&
      dueAt === undefined &&
      isDone === undefined
    ) {
      throw new ValidationError('No fields to update');
    }

    // Look up task
    const existing = await prisma.task.findUnique({ where: { id } });

    // 404 for: not found, belongs to other user, or soft-deleted
    if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
      throw new NotFound('Task not found');
    }

    // Last-write-wins: if the client sent an `updatedAt` that is not newer
    // than the server-side value, drop the update and return the existing
    // row. API_CONTRACT sync summary §5.
    if (body.updatedAt && new Date(body.updatedAt) <= existing.updatedAt) {
      return res.status(200).json(serializeTask(existing));
    }

    const updated = await prisma.task.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(notes !== undefined && { notes }),
        ...(dueAt !== undefined && { dueAt: dueAt ? new Date(dueAt) : null }),
        ...(isDone !== undefined && { isDone }),
        ...(body.updatedAt ? { updatedAt: new Date(body.updatedAt) } : {}),
      },
    });

    return res.status(200).json(serializeTask(updated));
  }),
);

// ─── DELETE /tasks/:id ───────────────────────────────────────────────────────

tasksRouter.delete(
  '/tasks/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;

    // Look up task
    const existing = await prisma.task.findUnique({ where: { id } });

    // 404 for: not found, belongs to other user, or already soft-deleted
    if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
      throw new NotFound('Task not found');
    }

    // Soft delete — prisma @updatedAt bumps updated_at automatically
    await prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return res.status(204).send();
  }),
);
