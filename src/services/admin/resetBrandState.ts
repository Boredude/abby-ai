import type pg from 'pg';

export type ResetSummary = {
  phone: string;
  brandId: string | null;
  rowsDeleted: {
    mastraMessages: number;
    mastraThreads: number;
    mastraResources: number;
    mastraWorkflowSnapshots: number;
    brand: number;
  };
};

/**
 * Wipes all server-side state for the given WhatsApp phone so a brand-new
 * onboarding conversation can begin on the same number.
 *
 * Removes:
 *   - the brand row (cascades to conversations, post_drafts, workflow_runs)
 *   - Mastra memory threads + messages keyed by `brand:<brandId>` or resourceId
 *   - the Mastra resource row keyed by brandId
 *   - any Mastra workflow snapshots tied to that resource
 *
 * Idempotent: returns 0 counts (and `brandId: null`) if no brand is found.
 */
export async function resetBrandByPhone(pool: pg.Pool, rawPhone: string): Promise<ResetSummary> {
  const phone = rawPhone.replace(/[^\d]/g, '');
  if (!phone) {
    throw new Error(`Could not extract digits from phone "${rawPhone}"`);
  }

  const empty: ResetSummary['rowsDeleted'] = {
    mastraMessages: 0,
    mastraThreads: 0,
    mastraResources: 0,
    mastraWorkflowSnapshots: 0,
    brand: 0,
  };

  const found = await pool.query<{ id: string }>(
    'select id from brands where wa_phone = $1',
    [phone],
  );
  const brandId = found.rows[0]?.id ?? null;
  if (!brandId) {
    return { phone, brandId: null, rowsDeleted: empty };
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
      phone,
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
