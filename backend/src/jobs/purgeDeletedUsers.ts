import type { Job } from 'pg-boss';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import type { PurgeDeletedUsersPayload } from './boss.js';

const RETENTION_DAYS = 30;

/**
 * pg-boss handler for the daily purge-deleted-users cron. Hard-deletes users
 * whose `deletionRequestedAt` is older than the retention window. Prisma
 * `onDelete: Cascade` handles tasks/events/chat_messages/devices/refresh_tokens
 * automatically.
 *
 * Signature matches pg-boss v12's WorkHandler — a batch array. We iterate
 * per-job with individual try/catch so one bad job doesn't block the queue.
 */
export async function handlePurgeDeletedUsers(
  jobs: Job<PurgeDeletedUsersPayload>[],
): Promise<void> {
  for (const job of jobs) {
    try {
      await runPurge(job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'purge-deleted-users job failed');
      throw err; // let pg-boss retry per queue policy
    }
  }
}

async function runPurge(jobId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Single deleteMany closes the TOCTOU window between find + delete: a user
  // who signs back in and clears `deletionRequestedAt` between the two calls
  // no longer risks being caught in the delete set.
  const { count } = await prisma.user.deleteMany({
    where: { deletionRequestedAt: { lt: cutoff, not: null } },
  });

  if (count === 0) {
    logger.info({ jobId }, 'purge: no users past retention window');
    return;
  }

  logger.info({ jobId, deleted: count, cutoff }, 'purge: hard-deleted users');
}
