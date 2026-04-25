import { getDb } from '../client.js';
import { webhookEvents } from '../schema.js';

/**
 * Tries to record a webhook event by idempotency key.
 * Returns `true` if it was newly recorded, `false` if it was a duplicate.
 */
export async function tryRecordWebhookEvent(
  idempotencyKey: string,
  source: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(webhookEvents)
    .values({ idempotencyKey, source })
    .onConflictDoNothing({ target: webhookEvents.idempotencyKey })
    .returning({ idempotencyKey: webhookEvents.idempotencyKey });
  return rows.length > 0;
}
