import { logger } from '../config/logger.js';
import { QUEUES, getBoss } from './queue.js';
import { handleApprovalReminder } from './handlers/approvalReminder.js';
import {
  handleDeliverApprovedPost,
  type DeliverApprovedPostPayload,
} from './handlers/deliverApprovedPost.js';
import { handleWeeklyPlanning } from './handlers/weeklyPlanning.js';

/**
 * Boot all pg-boss workers and recurring schedules.
 * Idempotent: pg-boss `schedule` is upsert-style.
 */
export async function startWorkers(): Promise<void> {
  const boss = await getBoss();

  await boss.work<DeliverApprovedPostPayload>(
    QUEUES.deliverApprovedPost,
    async (jobs) => {
      // pg-boss v10+ delivers an array of jobs to the handler.
      const list = Array.isArray(jobs) ? jobs : [jobs];
      for (const job of list) {
        try {
          await handleDeliverApprovedPost(job.data);
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'deliverApprovedPost handler failed');
          throw err;
        }
      }
    },
  );

  await boss.work(QUEUES.weeklyPlanning, async () => {
    await handleWeeklyPlanning();
  });

  await boss.work(QUEUES.approvalReminder, async () => {
    await handleApprovalReminder();
  });

  // Recurring schedules.
  // Mondays 09:00 UTC — fans out the week's drafts.
  await boss.schedule(QUEUES.weeklyPlanning, '0 9 * * 1');
  // Every 6 hours — nudges stale pending approvals.
  await boss.schedule(QUEUES.approvalReminder, '0 */6 * * *');

  logger.info('Workers + schedules started');
}
