import { PgBoss } from 'pg-boss';
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';

let boss: PgBoss | null = null;

export const QUEUES = {
  deliverApprovedPost: 'abby.deliver-approved-post',
  weeklyPlanning: 'abby.weekly-planning',
  approvalReminder: 'abby.approval-reminder',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const env = loadEnv();
  boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (err: unknown) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }
  logger.info({ queues: Object.values(QUEUES) }, 'pg-boss started');
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true });
  boss = null;
}
