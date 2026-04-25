import 'dotenv/config';
import pg from 'pg';
import { resetBrandByPhone } from '../services/admin/resetBrandState.js';

/**
 * CLI wrapper around `resetBrandByPhone`. Wipes all server-side state for a
 * given WhatsApp phone so you can start a fresh onboarding conversation.
 *
 * Usage:
 *   pnpm reset-brand 972533368788
 *   pnpm reset-brand "+972 53 336-8788"   # punctuation is stripped
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const rawPhone = process.argv.slice(2).join(' ').trim();
  if (!rawPhone) {
    console.error('Usage: pnpm reset-brand <phone>');
    console.error('Example: pnpm reset-brand 972533368788');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const summary = await resetBrandByPhone(pool, rawPhone);
    if (!summary.brandId) {
      console.log(`No brand found for phone ${summary.phone} — nothing to reset.`);
      return;
    }
    const r = summary.rowsDeleted;
    console.log(`Reset brand ${summary.brandId} (phone=${summary.phone})`);
    console.log(`  mastra_messages:          ${r.mastraMessages} rows deleted`);
    console.log(`  mastra_threads:           ${r.mastraThreads} rows deleted`);
    console.log(`  mastra_resources:         ${r.mastraResources} rows deleted`);
    console.log(`  mastra_workflow_snapshot: ${r.mastraWorkflowSnapshots} rows deleted`);
    console.log(`  brands (cascades to conversations/post_drafts/workflow_runs): ${r.brand} row deleted`);
    console.log(`Done. Send any new WhatsApp message to start onboarding from scratch.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
