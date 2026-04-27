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
    brand: number;
  };
};

const EMPTY_ROWS: ResetSummary['rowsDeleted'] = {
  mastraMessages: 0,
  mastraThreads: 0,
  mastraResources: 0,
  mastraWorkflowSnapshots: 0,
  brand: 0,
};

/**
 * Wipes all server-side state for the brand reachable on `(channelKind, externalId)`.
 *
 * Removes:
 *   - the brand row (cascades to conversations, post_drafts, workflow_runs, brand_channels)
 *   - Mastra memory threads + messages keyed by `brand:<brandId>` or resourceId
 *   - the Mastra resource row keyed by brandId
 *   - any Mastra workflow snapshots tied to that resource
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

    const msgs = await client.query(
      'delete from mastra_messages where thread_id = $1 or "resourceId" = $2',
      [threadId, brandId],
    );
    const threads = await client.query(
      'delete from mastra_threads where id = $1 or "resourceId" = $2',
      [threadId, brandId],
    );
    const resources = await client.query('delete from mastra_resources where id = $1', [brandId]);
    const snaps = await client.query(
      'delete from mastra_workflow_snapshot where "resourceId" = $1',
      [brandId],
    );
    const brandDel = await client.query('delete from brands where id = $1', [brandId]);

    await client.query('commit');

    return {
      channelKind: kind,
      externalId,
      brandId,
      rowsDeleted: {
        mastraMessages: msgs.rowCount ?? 0,
        mastraThreads: threads.rowCount ?? 0,
        mastraResources: resources.rowCount ?? 0,
        mastraWorkflowSnapshots: snaps.rowCount ?? 0,
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
