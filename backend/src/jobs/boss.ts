import { PgBoss } from 'pg-boss';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// ─── Job names ─────────────────────────────────────────────────────────────
// Keep in one place so producers and consumers stay in sync. Names double as
// pg-boss queue names.

export const JobName = {
  SendReminder: 'send-reminder',
  PurgeDeletedUsers: 'purge-deleted-users',
} as const;
export type JobName = (typeof JobName)[keyof typeof JobName];

// Job payload shapes. Consumers cast; producers construct.
export interface SendReminderPayload {
  eventId: string;
}
export interface PurgeDeletedUsersPayload {
  // scheduled cron trigger — empty payload
  _?: undefined;
}

// ─── pg-boss singleton ─────────────────────────────────────────────────────

let bossInstance: PgBoss | null = null;

export function getBoss(): PgBoss {
  if (!bossInstance) {
    throw new Error('pg-boss not started — call startBoss() during bootstrap');
  }
  return bossInstance;
}

/**
 * Start pg-boss. Idempotent — repeat calls return the existing instance.
 * pg-boss creates its own `pgboss` schema on first start; migrations are
 * managed internally by pg-boss, no Prisma migration needed.
 */
export async function startBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;

  const boss = new PgBoss({ connectionString: config.DATABASE_URL });

  boss.on('error', (err: unknown) => {
    logger.error({ err }, 'pg-boss error');
  });

  await boss.start();

  // Register the queues so consumers can subscribe. Retry policy is per-queue.
  // Handlers are wired by T3.4 (send-reminder) and T6.1 (purge-deleted-users).
  const queueOptions = { retryLimit: 3, retryDelay: 60, retryBackoff: true };
  await boss.createQueue(JobName.SendReminder, queueOptions);
  await boss.createQueue(JobName.PurgeDeletedUsers, queueOptions);

  bossInstance = boss;
  logger.info('pg-boss started');
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (!bossInstance) return;
  await bossInstance.stop({ graceful: true });
  bossInstance = null;
  logger.info('pg-boss stopped');
}
