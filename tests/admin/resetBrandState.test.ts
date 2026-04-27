import { describe, expect, it, vi } from 'vitest';
import { resetBrandByChannel } from '../../src/services/admin/resetBrandState.js';

type Call = { sql: string; params: unknown[] };

/**
 * Builds a fake `pg.Pool` whose `pool.query` returns the brand_channels lookup
 * row, and whose `pool.connect()` hands back a `client` that records every
 * SQL/param pair so the test can assert what the reset issued.
 *
 * The fake recognises the `to_regclass($1)` probe and answers based on
 * `existingTables` — anything not in that set returns null so the
 * `deleteIfExists` helper skips the DELETE entirely.
 */
function makeFakePool(args: {
  brandId: string | null;
  existingTables: Set<string>;
  rowCounts?: Record<string, number>;
}) {
  const { brandId, existingTables, rowCounts = {} } = args;
  const calls: Call[] = [];

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('to_regclass')) {
        const tbl = String(params[0]);
        return { rows: [{ regclass: existingTables.has(tbl) ? tbl : null }] };
      }
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }
      const m = sql.match(/^delete from ([\w.]+)/);
      if (m) {
        return { rows: [], rowCount: rowCounts[m[1]!] ?? 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn(async (_sql: string, _params: unknown[] = []) => {
      return { rows: brandId ? [{ brand_id: brandId }] : [] };
    }),
    connect: vi.fn(async () => client),
  };

  return { pool, client, calls };
}

describe('resetBrandByChannel', () => {
  it('returns an empty summary when no brand is mapped to the channel', async () => {
    const { pool } = makeFakePool({
      brandId: null,
      existingTables: new Set(),
    });

    const result = await resetBrandByChannel(pool as never, {
      kind: 'whatsapp',
      externalId: '15551112222',
    });

    expect(result.brandId).toBeNull();
    expect(result.rowsDeleted).toEqual({
      mastraMessages: 0,
      mastraThreads: 0,
      mastraResources: 0,
      mastraWorkflowSnapshots: 0,
      mastraObservationalMemory: 0,
      pgBossJobs: 0,
      brand: 0,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('wipes every brand-scoped table inside a single transaction', async () => {
    const brandId = 'b-1';
    const { pool, client, calls } = makeFakePool({
      brandId,
      existingTables: new Set([
        'mastra_messages',
        'mastra_threads',
        'mastra_resources',
        'mastra_workflow_snapshot',
        'mastra_observational_memory',
        'pgboss.job',
      ]),
    });

    const result = await resetBrandByChannel(pool as never, {
      kind: 'whatsapp',
      externalId: '15551112222',
    });

    expect(result.brandId).toBe(brandId);
    expect(client.query.mock.calls[0]?.[0]).toBe('begin');
    expect(calls.at(-1)?.sql).toBe('commit');

    const deleteSql = calls.filter((c) => c.sql.startsWith('delete from')).map((c) => c.sql);
    expect(deleteSql).toEqual([
      expect.stringContaining('delete from mastra_messages'),
      expect.stringContaining('delete from mastra_threads'),
      expect.stringContaining('delete from mastra_resources'),
      expect.stringContaining('delete from mastra_workflow_snapshot'),
      expect.stringContaining('delete from mastra_observational_memory'),
      expect.stringContaining('delete from pgboss.job'),
      expect.stringContaining('delete from brands'),
    ]);

    const pgBossDelete = calls.find((c) => c.sql.includes('pgboss.job'));
    expect(pgBossDelete?.sql).toContain("data->>'brandId' = $1");
    expect(pgBossDelete?.sql).toContain("state in ('created', 'retry', 'active')");
    expect(pgBossDelete?.params).toEqual([brandId]);

    expect(result.rowsDeleted.brand).toBe(1);
    expect(result.rowsDeleted.mastraMessages).toBe(1);
    expect(result.rowsDeleted.pgBossJobs).toBe(1);
    expect(result.rowsDeleted.mastraObservationalMemory).toBe(1);
  });

  it('skips DELETEs for mastra/pgboss tables that do not exist in the DB', async () => {
    // Simulate a fresh dev DB where Mastra has only created the core memory
    // tables and pg-boss hasn't run yet.
    const { pool, calls } = makeFakePool({
      brandId: 'b-2',
      existingTables: new Set(['mastra_messages', 'mastra_threads', 'mastra_resources']),
    });

    const result = await resetBrandByChannel(pool as never, {
      kind: 'whatsapp',
      externalId: '15551112222',
    });

    const deletedTables = calls
      .filter((c) => c.sql.startsWith('delete from'))
      .map((c) => c.sql.match(/delete from ([\w.]+)/)?.[1]);
    expect(deletedTables).toEqual([
      'mastra_messages',
      'mastra_threads',
      'mastra_resources',
      'brands',
    ]);
    expect(result.rowsDeleted.mastraWorkflowSnapshots).toBe(0);
    expect(result.rowsDeleted.mastraObservationalMemory).toBe(0);
    expect(result.rowsDeleted.pgBossJobs).toBe(0);
  });

  it('rolls back the transaction if a DELETE fails', async () => {
    const { pool, client } = makeFakePool({
      brandId: 'b-3',
      existingTables: new Set(['mastra_messages']),
    });

    let queryCount = 0;
    const original = client.query;
    client.query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queryCount += 1;
      if (sql.startsWith('delete from mastra_messages')) {
        throw new Error('boom');
      }
      return original(sql, params);
    });

    await expect(
      resetBrandByChannel(pool as never, { kind: 'whatsapp', externalId: '15551112222' }),
    ).rejects.toThrow('boom');

    const allCalls = client.query.mock.calls.map((c) => c[0]);
    expect(allCalls).toContain('rollback');
    expect(allCalls).not.toContain('commit');
    expect(queryCount).toBeGreaterThan(0);
  });
});
