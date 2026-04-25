import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const env = loadEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  db = drizzle(getPool(), { schema });
  return db;
}

export type DB = ReturnType<typeof getDb>;
export { schema };
