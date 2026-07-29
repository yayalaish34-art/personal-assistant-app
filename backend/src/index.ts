import { app } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { startBoss, stopBoss } from './jobs/boss.js';
import { registerJobHandlers } from './jobs/register.js';

async function main(): Promise<void> {
  // pg-boss stores its queue in Postgres, so it only starts when a database is
  // configured. Without one the server still serves the stateless AI routes.
  if (config.DATABASE_URL) {
    const boss = await startBoss();
    await registerJobHandlers(boss);
  } else {
    logger.info('no DATABASE_URL — running without the database or job queue');
  }

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'server listening');
  });

  function shutdown(signal: NodeJS.Signals): void {
    logger.info({ signal }, 'shutting down');
    server.close(async (err) => {
      if (err) logger.error({ err }, 'server close failed');
      if (config.DATABASE_URL) {
        try {
          await stopBoss();
        } catch (bossErr) {
          logger.error({ err: bossErr }, 'pg-boss stop failed');
        }
      }
      process.exit(err ? 1 : 0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'fatal bootstrap error');
  process.exit(1);
});
