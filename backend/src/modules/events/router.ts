import { Router } from 'express';
import { z } from 'zod';
import type { Event } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth.js';
import { prisma } from '../../db.js';
import { ValidationError, NotFound, Conflict } from '../../lib/errors.js';
import { asyncHandler, parseBody, parseQuery } from '../../lib/http.js';
import { scheduleEventReminder, cancelEventReminder } from './reminders.js';

export const eventsRouter = Router();

// ─── Serializer ──────────────────────────────────────────────────────────────

export function serializeEvent(e: Event) {
  return {
    id: e.id,
    title: e.title,
    note: e.note ?? null,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    reminderMinutesBefore: e.reminderMinutesBefore ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    deletedAt: e.deletedAt ? e.deletedAt.toISOString() : null,
  };
}

// ─── GET /events?updatedSince=<ISO> ─────────────────────────────────────────

const getEventsSchema = z.object({
  updatedSince: z.string().datetime().optional(),
});

eventsRouter.get(
  '/events',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { updatedSince } = parseQuery(getEventsSchema, req);
    const userId = req.user!.id;

    const events = await prisma.event.findMany({
      where: {
        userId,
        ...(updatedSince
          ? { updatedAt: { gte: new Date(updatedSince) } }
          : { deletedAt: null }),
      },
      orderBy: { updatedAt: 'asc' },
    });

    res.json({
      events: events.map(serializeEvent),
      serverTime: new Date().toISOString(),
    });
  }),
);

// ─── POST /events ────────────────────────────────────────────────────────────

const postEventSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  note: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  reminderMinutesBefore: z.number().int().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
});

eventsRouter.post(
  '/events',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = parseBody(postEventSchema, req);
    const userId = req.user!.id;

    const startsAt = new Date(body.startsAt);
    const endsAt = body.endsAt
      ? new Date(body.endsAt)
      : new Date(startsAt.getTime() + 60 * 60 * 1000); // default +60 min

    // Validate endsAt > startsAt when both are provided
    if (body.endsAt && endsAt <= startsAt) {
      throw new ValidationError('endsAt must be after startsAt');
    }

    // Check for existing event with this id
    const existing = await prisma.event.findUnique({ where: { id: body.id } });

    if (existing) {
      if (existing.userId !== userId) {
        throw new Conflict('Event id belongs to a different user');
      }
      // Same user + same id → idempotent 200. Reschedule the reminder in
      // case the client retried after the DB write succeeded but the boss
      // call failed (QA-3 L4). scheduleEventReminder is upsert-safe.
      await scheduleEventReminder(existing);
      return res.status(200).json(serializeEvent(existing));
    }

    // Create new event
    const created = await prisma.event.create({
      data: {
        id: body.id,
        userId,
        title: body.title,
        note: body.note ?? null,
        startsAt,
        endsAt,
        reminderMinutesBefore: body.reminderMinutesBefore ?? null,
        // Use client updatedAt if provided (last-write-wins), else let Prisma set it
        ...(body.updatedAt ? { updatedAt: new Date(body.updatedAt) } : {}),
      },
    });

    await scheduleEventReminder(created);
    return res.status(201).json(serializeEvent(created));
  }),
);

// ─── PATCH /events/:id ───────────────────────────────────────────────────────

const patchEventSchema = z.object({
  title: z.string().min(1).optional(),
  note: z.string().nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  reminderMinutesBefore: z.number().int().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
});

eventsRouter.patch(
  '/events/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = parseBody(patchEventSchema, req);
    const userId = req.user!.id;
    const { id } = req.params as { id: string };

    // Reject empty body (updatedAt alone isn't an "update")
    const mutatingKeys = Object.keys(body).filter((k) => k !== 'updatedAt');
    if (mutatingKeys.length === 0) {
      throw new ValidationError('Request body must include at least one field');
    }

    // Load existing row
    const existing = await prisma.event.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
      throw new NotFound('Event not found');
    }

    // Last-write-wins: client's updatedAt must be newer than server's.
    if (body.updatedAt && new Date(body.updatedAt) <= existing.updatedAt) {
      return res.json(serializeEvent(existing));
    }

    // Compute merged startsAt / endsAt for validation
    const mergedStartsAt =
      body.startsAt !== undefined ? new Date(body.startsAt) : existing.startsAt;
    const mergedEndsAt =
      body.endsAt !== undefined ? new Date(body.endsAt) : existing.endsAt;

    // Validate merged state: endsAt must be after startsAt
    if (mergedEndsAt <= mergedStartsAt) {
      throw new ValidationError('endsAt must be after startsAt');
    }

    const updated = await prisma.event.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.note !== undefined && { note: body.note }),
        ...(body.startsAt !== undefined && { startsAt: new Date(body.startsAt) }),
        ...(body.endsAt !== undefined && { endsAt: new Date(body.endsAt) }),
        ...(body.reminderMinutesBefore !== undefined && {
          reminderMinutesBefore: body.reminderMinutesBefore,
        }),
        ...(body.updatedAt ? { updatedAt: new Date(body.updatedAt) } : {}),
      },
    });

    // Reschedule reminder if startsAt or reminderMinutesBefore changed.
    // Cheaper to just always reschedule than to diff — upsert is idempotent.
    if (body.startsAt !== undefined || body.reminderMinutesBefore !== undefined) {
      await scheduleEventReminder(updated);
    }

    res.json(serializeEvent(updated));
  }),
);

// ─── DELETE /events/:id ──────────────────────────────────────────────────────

eventsRouter.delete(
  '/events/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };

    const existing = await prisma.event.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId || existing.deletedAt !== null) {
      throw new NotFound('Event not found');
    }

    // Soft delete: set deletedAt; Prisma @updatedAt bumps updatedAt automatically
    await prisma.event.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await cancelEventReminder(id);

    res.status(204).send();
  }),
);
