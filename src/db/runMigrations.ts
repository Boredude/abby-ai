import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Apply any pending Drizzle migrations from the `./drizzle` folder against the
 * provided `DATABASE_URL` (defaults to `process.env.DATABASE_URL`).
 *
 * Used both as a standalone CLI (see `src/db/migrate.ts`) and at app startup
 * (see `src/index.ts`) so a deploy is self-applying — adding a column then
 * shipping new code that depends on it never leaves prod in a half-migrated
 * state again.
 *
 * Uses its own short-lived connection pool so it doesn't depend on (or
 * disturb) the app's main `getPool()`.
 */
export async function runMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}
