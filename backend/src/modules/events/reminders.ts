import { getBoss, JobName, type SendReminderPayload } from '../../jobs/boss.js';
import { logger } from '../../lib/logger.js';

/**
 * Reminder scheduling for events.
 *
 * Idempotency model:
 *   - The pg-boss `singletonKey` is set to the event id, so at most one pending
 *     `send-reminder` job exists per event at any time.
 *   - `scheduleEventReminder` uses `upsert` — safe to call on create OR update.
 *   - `cancelEventReminder` deletes any pending job for the event.
 *
 * Skip rules:
 *   - `reminderMinutesBefore === null` → skip (also cancels any existing job).
 *   - Computed reminder time is in the past → skip (also cancels).
 *
 * Delete-safety at fire time: the handler (T3.4) re-checks `deletedAt` on the
 * event before sending push, so a race between delete and fire is harmless.
 */

export interface EventForReminder {
  id: string;
  startsAt: Date;
  reminderMinutesBefore: number | null;
}

export async function scheduleEventReminder(event: EventForReminder): Promise<void> {
  try {
    if (event.reminderMinutesBefore === null) {
      await cancelEventReminder(event.id);
      return;
    }

    const reminderTime = new Date(
      event.startsAt.getTime() - event.reminderMinutesBefore * 60_000,
    );

    if (reminderTime.getTime() <= Date.now()) {
      // No point scheduling a job for the past. Cancel any stale pending job.
      await cancelEventReminder(event.id);
      logger.debug({ eventId: event.id }, 'reminder time in past — skipping');
      return;
    }

    const boss = getBoss();
    const payload: SendReminderPayload = { eventId: event.id };

    await boss.upsert({
      name: JobName.SendReminder,
      data: payload,
      options: {
        singletonKey: event.id,
        startAfter: reminderTime,
      },
    });

    logger.debug({ eventId: event.id, reminderTime }, 'reminder scheduled');
  } catch (err) {
    // pg-boss unavailable (e.g. in tests) — degrade gracefully. Production
    // health checks should catch a real outage; a failed schedule must not
    // fail the API request that triggered it.
    logger.warn({ err, eventId: event.id }, 'failed to schedule reminder');
  }
}

export async function cancelEventReminder(eventId: string): Promise<void> {
  try {
    const boss = getBoss();

    const jobs = await boss.findJobs(JobName.SendReminder, {
      key: eventId,
      queued: true,
    });

    if (jobs.length === 0) return;

    await boss.deleteJob(
      JobName.SendReminder,
      jobs.map((j) => j.id),
    );

    logger.debug({ eventId, jobIds: jobs.map((j) => j.id) }, 'reminder cancelled');
  } catch (err) {
    logger.warn({ err, eventId }, 'failed to cancel reminder');
  }
}
