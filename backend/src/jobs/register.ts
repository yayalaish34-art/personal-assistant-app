import type { PgBoss } from 'pg-boss';
import {
  JobName,
  type SendReminderPayload,
  type PurgeDeletedUsersPayload,
} from './boss.js';
import { handleSendReminder } from './sendReminder.js';
import { handlePurgeDeletedUsers } from './purgeDeletedUsers.js';

/**
 * Register handlers + schedule cron jobs. Called after `startBoss()` in main().
 */
export async function registerJobHandlers(boss: PgBoss): Promise<void> {
  await boss.work<SendReminderPayload>(JobName.SendReminder, handleSendReminder);
  await boss.work<PurgeDeletedUsersPayload>(
    JobName.PurgeDeletedUsers,
    handlePurgeDeletedUsers,
  );

  // Daily at 03:00 UTC — cheap window, low DB traffic. pg-boss schedule is
  // idempotent: repeat calls update the existing schedule.
  await boss.schedule(JobName.PurgeDeletedUsers, '0 3 * * *');
}
