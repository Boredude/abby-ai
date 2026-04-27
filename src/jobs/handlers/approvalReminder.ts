import { getBrandChannel } from '../../channels/registry.js';
import { logger } from '../../config/logger.js';
import { listStalePendingApprovals } from '../../db/repositories/postDrafts.js';

const STALE_HOURS = 24;

/**
 * Approval reminder cron.
 *
 * Finds drafts that have been sitting in `pending_approval` for >24h and
 * sends a polite nudge to the brand on their primary channel. Re-uses the
 * same approve/edit/reject button payloads so the existing dispatcher →
 * workflow.resume path still works.
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
      const channel = await getBrandChannel(draft.brandId);
      if (!channel) {
        logger.warn({ draftId: draft.id, brandId: draft.brandId }, 'approvalReminder: no channel for brand');
        continue;
      }
      if (!channel.capabilities.supportsButtons) {
        await channel.sendText(
          `Quick nudge — I have a post draft waiting on your nod. Reply 'approve', 'edit', or 'reject' (draft id ${draft.id}).`,
        );
        continue;
      }
      await channel.sendButtons({
        bodyText: `Quick nudge — I have a post draft waiting on your nod. Want me to ship it as-is, tweak it, or scrap it?`,
        footer: `Draft from ${draft.createdAt.toLocaleDateString('en-US')}`,
        buttons: [
          { id: `approve_${draft.id}`, title: 'Approve' },
          { id: `edit_${draft.id}`, title: 'Edit' },
          { id: `reject_${draft.id}`, title: 'Reject' },
        ],
      });
    } catch (err) {
      logger.error({ err, draftId: draft.id }, 'approvalReminder: failed for draft');
    }
  }
}
