import { logger } from '../../config/logger.js';
import { findBrandById } from '../../db/repositories/brands.js';
import { listStalePendingApprovals } from '../../db/repositories/postDrafts.js';
import { sendButtons } from '../../services/kapso/client.js';

const STALE_HOURS = 24;

/**
 * Approval reminder cron.
 *
 * Finds drafts that have been sitting in `pending_approval` for >24h and
 * sends a polite nudge to the brand. Re-uses the same approve/edit/reject
 * button payloads so the existing dispatcher → workflow.resume path still
 * works.
 */
export async function handleApprovalReminder(): Promise<void> {
  const stale = await listStalePendingApprovals(STALE_HOURS);
  if (stale.length === 0) {
    logger.info('approvalReminder: nothing to nudge');
    return;
  }
  logger.info({ count: stale.length }, 'approvalReminder: sending nudges');

  for (const draft of stale) {
    try {
      const brand = await findBrandById(draft.brandId);
      if (!brand) continue;
      await sendButtons({
        to: brand.waPhone,
        bodyText:
          `Quick nudge — I have a post draft waiting on your nod. Want me to ship it as-is, tweak it, or scrap it?`,
        footer: `Draft from ${draft.createdAt.toLocaleDateString('en-US')}`,
        buttons: [
          { type: 'reply', reply: { id: `approve_${draft.id}`, title: 'Approve' } },
          { type: 'reply', reply: { id: `edit_${draft.id}`, title: 'Edit' } },
          { type: 'reply', reply: { id: `reject_${draft.id}`, title: 'Reject' } },
        ],
      });
    } catch (err) {
      logger.error({ err, draftId: draft.id }, 'approvalReminder: failed for draft');
    }
  }
}
