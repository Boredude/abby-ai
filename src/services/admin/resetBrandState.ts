import type pg from 'pg';
import type { ChannelKind } from '../../db/schema.js';

export type ResetSummary = {
  channelKind: ChannelKind;
  externalId: string;
  brandId: string | null;
  rowsDeleted: {
    mastraMessages: number;
    mastraThreads: number;
    mastraResources: number;
    mastraWorkflowSnapshots: number;
    mastraObservationalMemory: number;
    pgBossJobs: number;
    brand: number;
  };
};

const EMPTY_ROWS: ResetSummary['rowsDeleted'] = {
  mastraMessages: 0,
  mastraThreads: 0,
  mastraResources: 0,
  mastraWorkflowSnapshots: 0,
  mastraObservationalMemory: 0,
  pgBossJobs: 0,
  brand: 0,
};

/**
 * Runs a DELETE only when `qualifiedTable` actually exists. Mastra creates its
 * tables lazily based on which features are enabled (working memory, observers,
 * etc.) and pg-boss lives in its own schema, so we don't want a missing table
 * to abort the whole reset transaction.
 */
async function deleteIfExists(
  client: pg.PoolClient,
  qualifiedTable: string,
  whereSql: string,
  params: unknown[],
): Promise<number> {
  const exists = await client.query<{ regclass: string | null }>(
    'select to_regclass($1)::text as regclass',
    [qualifiedTable],
  );
  if (!exists.rows[0]?.regclass) return 0;
  const res = await client.query(`delete from ${qualifiedTable} ${whereSql}`, params);
  return res.rowCount ?? 0;
}

/**
 * Wipes all server-side state for the brand reachable on `(channelKind, externalId)`.
 *
 * After this returns, the brand has no DB footprint left:
 *   - the brand row is gone (cascades to brand_channels, conversations,
 *     post_drafts, workflow_runs)
 *   - every Mastra memory artifact keyed by `brand:<brandId>` or resourceId is
 *     gone (messages, threads, resource row + working memory blob, workflow
 *     snapshots, observational memory if enabled)
 *   - any pending pg-boss `deliverApprovedPost` jobs carrying this brandId are
 *     cancelled, so a stale post can't fire after the user starts over
 *
 * Idempotent: returns 0 counts (and `brandId: null`) if no brand is found.
 */
export async function resetBrandByChannel(
  pool: pg.Pool,
  args: { kind: ChannelKind; externalId: string },
): Promise<ResetSummary> {
  const { kind, externalId } = args;

  const found = await pool.query<{ brand_id: string }>(
    'select brand_id from brand_channels where kind = $1 and external_id = $2',
    [kind, externalId],
  );
  const brandId = found.rows[0]?.brand_id ?? null;
  if (!brandId) {
    return { channelKind: kind, externalId, brandId: null, rowsDeleted: EMPTY_ROWS };
  }

  const threadId = `brand:${brandId}`;
  const client = await pool.connect();
  try {
    await client.query('begin');

    const mastraMessages = await deleteIfExists(
      client,
      'mastra_messages',
      'where thread_id = $1 or "resourceId" = $2',
      [threadId, brandId],
    );
    const mastraThreads = await deleteIfExists(
      client,
      'mastra_threads',
      'where id = $1 or "resourceId" = $2',
      [threadId, brandId],
    );
    const mastraResources = await deleteIfExists(client, 'mastra_resources', 'where id = $1', [
      brandId,
    ]);
    const mastraWorkflowSnapshots = await deleteIfExists(
      client,
      'mastra_workflow_snapshot',
      'where "resourceId" = $1',
      [brandId],
    );
    // Mastra's observational memory feature (off by default) keys by both
    // resourceId and threadId — wipe both so future toggling can't surface
    // stale brand observations.
    const mastraObservationalMemory = await deleteIfExists(
      client,
      'mastra_observational_memory',
      'where "resourceId" = $1 or "threadId" = $2',
      [brandId, threadId],
    );
    // pg-boss stores scheduled `deliverApprovedPost` jobs with the brandId in
    // their JSON payload. Without this, an approved-but-not-yet-delivered post
    // can fire after the brand has been reset (the handler is defensive about
    // missing drafts, but the orphaned job is still latent state).
    const pgBossJobs = await deleteIfExists(
      client,
      'pgboss.job',
      `where data->>'brandId' = $1 and state in ('created', 'retry', 'active')`,
      [brandId],
    );
    const brandDel = await client.query('delete from brands where id = $1', [brandId]);

    await client.query('commit');

    return {
      channelKind: kind,
      externalId,
      brandId,
      rowsDeleted: {
        mastraMessages,
        mastraThreads,
        mastraResources,
        mastraWorkflowSnapshots,
        mastraObservationalMemory,
        pgBossJobs,
        brand: brandDel.rowCount ?? 0,
      },
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
