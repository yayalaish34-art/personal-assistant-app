import Expo, {
  type ExpoPushMessage,
  type ExpoPushErrorTicket,
} from 'expo-server-sdk';
import type { Job } from 'pg-boss';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import type { SendReminderPayload } from './boss.js';

const expo = new Expo();

// ─── Localisation helpers ──────────────────────────────────────────────────

function buildMessage(
  language: 'he' | 'en',
  eventTitle: string,
  minutesBefore: number,
): Pick<ExpoPushMessage, 'title' | 'body'> {
  if (language === 'he') {
    const bodyHe = minutesBefore === 1 ? 'בעוד דקה' : `בעוד ${minutesBefore} דקות`;
    return { title: `תזכורת: ${eventTitle}`, body: bodyHe };
  }
  const bodyEn = minutesBefore === 1 ? 'In 1 minute' : `In ${minutesBefore} minutes`;
  return { title: `Reminder: ${eventTitle}`, body: bodyEn };
}

// ─── Handler for a single job ──────────────────────────────────────────────

async function processSendReminder(job: Job<SendReminderPayload>): Promise<void> {
  const { eventId } = job.data;

  // ── Step 1: fetch event ────────────────────────────────────────────────
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
  });

  if (!event) {
    logger.info({ eventId, jobId: job.id }, 'send-reminder: event not found or deleted — skipping');
    return;
  }

  // ── Step 2: reminder still enabled ────────────────────────────────────
  if (event.reminderMinutesBefore === null) {
    logger.info({ eventId, jobId: job.id }, 'send-reminder: reminder disabled since scheduling — skipping');
    return;
  }

  // ── Step 3: sanity-check wall-clock time (±5 min) ─────────────────────
  const expectedFireAt = new Date(
    event.startsAt.getTime() - event.reminderMinutesBefore * 60_000,
  );
  const driftMs = Math.abs(Date.now() - expectedFireAt.getTime());
  const FIVE_MINUTES_MS = 5 * 60_000;

  if (driftMs > FIVE_MINUTES_MS) {
    logger.warn(
      { eventId, jobId: job.id, driftMs, expectedFireAt },
      'send-reminder: stale job — likely rescheduled, skipping',
    );
    return;
  }

  // ── Step 4: load user and devices ─────────────────────────────────────
  const user = await prisma.user.findUnique({
    where: { id: event.userId },
    include: { devices: true },
  });

  if (!user) {
    logger.info(
      { eventId, userId: event.userId, jobId: job.id },
      'send-reminder: user not found — skipping',
    );
    return;
  }

  if (user.devices.length === 0) {
    logger.info(
      { eventId, userId: user.id, jobId: job.id },
      'send-reminder: user has no devices — skipping',
    );
    return;
  }

  // ── Step 5 + 6: build push messages ───────────────────────────────────
  const { title, body } = buildMessage(
    user.language,
    event.title,
    event.reminderMinutesBefore,
  );

  const messages: ExpoPushMessage[] = user.devices.map((device) => ({
    to: device.pushToken,
    title,
    body,
    sound: 'default' as const,
    data: { eventId },
  }));

  // Build a token→device map for later lookup.
  const devicesByToken = new Map(user.devices.map((d) => [d.pushToken, d]));

  // ── Step 7: send in chunks ─────────────────────────────────────────────
  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    let rawTickets: Awaited<ReturnType<typeof expo.sendPushNotificationsAsync>>;
    try {
      rawTickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      logger.warn(
        { err, eventId, jobId: job.id },
        'send-reminder: Expo sendPushNotificationsAsync failed',
      );
      continue;
    }

    // ── Step 8: handle per-ticket results ─────────────────────────────
    for (let i = 0; i < rawTickets.length; i++) {
      const ticket = rawTickets[i];
      const message = chunk[i];

      if (!ticket || !message) continue;

      if (ticket.status === 'ok') {
        // Receipt follow-up skipped for MVP.
        continue;
      }

      // status === 'error'
      const errTicket = ticket as ExpoPushErrorTicket;
      const pushToken = Array.isArray(message.to) ? message.to[0] : message.to;

      if (errTicket.details?.error === 'DeviceNotRegistered' && pushToken !== undefined) {
        const device = devicesByToken.get(pushToken);
        if (device) {
          try {
            await prisma.device.delete({ where: { id: device.id } });
            logger.info(
              { eventId, deviceId: device.id },
              'send-reminder: removed unregistered device',
            );
          } catch (deleteErr) {
            logger.warn(
              { deleteErr, deviceId: device.id },
              'send-reminder: failed to delete unregistered device',
            );
          }
        }
      } else {
        // Do NOT log the raw pushToken — it is a device-user PII identifier.
        logger.warn(
          {
            eventId,
            jobId: job.id,
            deviceId: pushToken ? devicesByToken.get(pushToken)?.id : undefined,
            error: errTicket.details?.error,
            message: errTicket.message,
          },
          'send-reminder: Expo error ticket',
        );
      }
    }
  }
}

// ─── pg-boss WorkHandler (receives array of jobs) ─────────────────────────

/**
 * pg-boss worker for `send-reminder`.
 *
 * pg-boss `work()` delivers a batch (array) of jobs. We process each one
 * individually so a single failed event never blocks the others.
 *
 * The function never throws — pg-boss marks unthrown completions as `completed`.
 */
export async function handleSendReminder(
  jobs: Job<SendReminderPayload>[],
): Promise<void> {
  for (const job of jobs) {
    try {
      await processSendReminder(job);
    } catch (err) {
      logger.error({ err, jobId: job.id, eventId: job.data.eventId }, 'send-reminder: unexpected error');
    }
  }
}
