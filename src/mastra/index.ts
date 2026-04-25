import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { loadEnv } from '../config/env.js';

let mastra: Mastra | null = null;

/**
 * Lazily build a single Mastra instance backed by Postgres storage.
 * Agents and workflows are registered in `./agents/index.ts` + `./workflows/index.ts`
 * and wired in below.
 */
export async function getMastra(): Promise<Mastra> {
  if (mastra) return mastra;

  const env = loadEnv();
  const storage = new PostgresStore({
    id: 'mastra-storage',
    connectionString: env.DATABASE_URL,
  });

  const { agents } = await import('./agents/index.js');
  const { workflows } = await import('./workflows/index.js');

  mastra = new Mastra({
    storage,
    agents,
    workflows,
  });

  return mastra;
}
