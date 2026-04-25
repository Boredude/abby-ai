import 'dotenv/config';
import { runMigrations } from './runMigrations.js';

/**
 * Standalone migration runner used by `pnpm run db:migrate`. Production also
 * runs the same logic at app startup via `runMigrations` (see `src/index.ts`);
 * this script stays useful for local dev, CI, and one-off backfills.
 */
async function main(): Promise<void> {
  console.log('Running database migrations...');
  await runMigrations();
  console.log('Migrations complete');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
