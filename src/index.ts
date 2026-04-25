import { serve } from '@hono/node-server';
import { logger } from './config/logger.js';
import { loadEnv } from './config/env.js';
import { stopBoss } from './jobs/queue.js';
import { startWorkers } from './jobs/workers.js';
import { getMastra } from './mastra/index.js';
import { getPool } from './db/client.js';
import { runMigrations } from './db/runMigrations.js';
import { app } from './server/app.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // Apply any pending Drizzle migrations before anything else touches the DB,
  // so a deploy that adds a new column is self-applying. Without this the app
  // would crash on the first query referencing a column that only exists in
  // schema.ts but not yet in the database (we hit exactly that on the
  // brand-board deploy: every `upsertBrandByPhone` failed with
  // `column "brand_board_image_url" does not exist`).
  await runMigrations(env.DATABASE_URL);
  logger.info('Database migrations applied');

  await getMastra();
  logger.info('Mastra instance ready');

  await startWorkers();

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, 'Abby HTTP server listening');
  });

  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ sig }, 'Shutting down');
      try {
        server.close();
        await stopBoss();
        await getPool().end();
      } catch (err) {
        logger.error({ err }, 'Shutdown error');
      } finally {
        process.exit(0);
      }
    });
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
