import { Router } from 'express';
import { z } from 'zod';
import type { Device } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth.js';
import { prisma } from '../../db.js';
import { asyncHandler, parseBody } from '../../lib/http.js';

export const devicesRouter = Router();

// ─── Serializer ──────────────────────────────────────────────────────────────

// Intentionally omits pushToken and userId to prevent leakage.
function serializeDevice(d: Pick<Device, 'id' | 'platform' | 'lastSeenAt'>) {
  return {
    id: d.id,
    platform: d.platform,
    lastSeenAt: d.lastSeenAt.toISOString(),
  };
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const postDeviceBodySchema = z.object({
  pushToken: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
});

// ─── POST /devices ───────────────────────────────────────────────────────────
//
// Upserts on (platform, pushToken).
// - No existing row → create with userId = req.user.id, lastSeenAt = now().
// - Existing row, same user → update lastSeenAt = now().
// - Existing row, different user → reassign to current user, lastSeenAt = now().

devicesRouter.post(
  '/devices',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = parseBody(postDeviceBodySchema, req);
    const userId = req.user!.id;
    const now = new Date();

    const existing = await prisma.device.findUnique({
      where: {
        platform_pushToken: {
          platform: body.platform as 'ios' | 'android' | 'web',
          pushToken: body.pushToken,
        },
      },
    });

    if (!existing) {
      // No existing row — create new device for this user.
      const device = await prisma.device.create({
        data: {
          userId,
          pushToken: body.pushToken,
          platform: body.platform as 'ios' | 'android' | 'web',
          lastSeenAt: now,
        },
      });
      return res.status(200).json({ device: serializeDevice(device) });
    }

    // Row exists — update lastSeenAt and (re)assign userId if needed.
    // Both same-user refresh and cross-user reassignment use the same update.
    const updated = await prisma.device.update({
      where: { id: existing.id },
      data: {
        userId,
        lastSeenAt: now,
      },
    });

    return res.status(200).json({ device: serializeDevice(updated) });
  }),
);
