import { logger } from '../../config/logger.js';
import { listActiveBrands } from '../../db/repositories/brands.js';
import { startWorkflow } from '../../services/workflowRunner.js';
import type { BrandCadence } from '../../db/schema.js';

const DEFAULT_POSTS_PER_WEEK = 3;
const DEFAULT_PREFERRED_HOUR = 10;

/**
 * Computes the next N delivery datetimes for a brand, spread across the
 * coming 7 days at their preferred hour-of-day.
 */
function computeSchedule(now: Date, cadence: BrandCadence | null): Date[] {
  const postsPerWeek = cadence?.postsPerWeek ?? DEFAULT_POSTS_PER_WEEK;
  const hour = cadence?.preferredHourLocal ?? DEFAULT_PREFERRED_HOUR;
  const stepDays = Math.max(1, Math.floor(7 / postsPerWeek));

  const dates: Date[] = [];
  for (let i = 0; i < postsPerWeek; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + (i + 1) * stepDays);
    d.setUTCHours(hour, 0, 0, 0);
    dates.push(d);
  }
  return dates;
}

/**
 * Weekly planning cron handler.
 *
 * For every active brand, fans out N postDraftApproval runs (one per planned
 * post for the coming week). Each run independently sends a WA preview and
 * waits for human approval. Approved drafts get auto-scheduled by the
 * approval workflow itself.
 */
export async function handleWeeklyPlanning(): Promise<void> {
  const brands = await listActiveBrands();
  logger.info({ brandCount: brands.length }, 'weeklyPlanning: starting');

  const now = new Date();
  for (const brand of brands) {
    const schedule = computeSchedule(now, brand.cadenceJson ?? null);
    for (const scheduledAt of schedule) {
      try {
        const { runId, status } = await startWorkflow({
          workflowId: 'postDraftApproval',
          brandId: brand.id,
          inputData: {
            brandId: brand.id,
            scheduledAt: scheduledAt.toISOString(),
          },
        });
        logger.info(
          { brandId: brand.id, runId, status, scheduledAt: scheduledAt.toISOString() },
          'weeklyPlanning: started approval run',
        );
      } catch (err) {
        logger.error({ err, brandId: brand.id }, 'weeklyPlanning: failed to start approval run');
      }
    }
  }
}
