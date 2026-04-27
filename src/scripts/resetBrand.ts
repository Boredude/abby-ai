import 'dotenv/config';
import pg from 'pg';
import { resetBrandByChannel } from '../services/admin/resetBrandState.js';
import type { ChannelKind } from '../db/schema.js';

/**
 * CLI wrapper around `resetBrandByChannel`. Wipes all server-side state for a
 * brand reachable on a given channel so you can start a fresh onboarding
 * conversation.
 *
 * Usage:
 *   pnpm reset-brand whatsapp 972533368788
 *   pnpm reset-brand whatsapp "+972 53 336-8788"   # punctuation is stripped for WA
 *
 * `<kind>` defaults to `whatsapp` if omitted (back-compat with the old
 * single-arg invocation).
 */

const KNOWN_KINDS: ChannelKind[] = ['whatsapp', 'sms', 'telegram', 'instagram', 'tiktok'];

function parseArgs(argv: string[]): { kind: ChannelKind; externalId: string } | null {
  const args = argv.slice(2);
  if (args.length === 0) return null;

  const first = args[0]!.toLowerCase();
  if (KNOWN_KINDS.includes(first as ChannelKind)) {
    const kind = first as ChannelKind;
    const rest = args.slice(1).join(' ').trim();
    if (!rest) return null;
    const externalId = kind === 'whatsapp' ? rest.replace(/[^\d]/g, '') : rest;
    if (!externalId) return null;
    return { kind, externalId };
  }

  // Single-arg legacy form: assume whatsapp + phone.
  const externalId = args.join(' ').replace(/[^\d]/g, '');
  if (!externalId) return null;
  return { kind: 'whatsapp', externalId };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const parsed = parseArgs(process.argv);
  if (!parsed) {
    console.error('Usage: pnpm reset-brand [<kind>] <externalId>');
    console.error('  <kind> is one of: whatsapp, sms, telegram, instagram, tiktok (default: whatsapp)');
    console.error('Example: pnpm reset-brand whatsapp 972533368788');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const summary = await resetBrandByChannel(pool, parsed);
    if (!summary.brandId) {
      console.log(
        `No brand found for ${summary.channelKind}:${summary.externalId} — nothing to reset.`,
      );
      return;
    }
    const r = summary.rowsDeleted;
    console.log(`Reset brand ${summary.brandId} (${summary.channelKind}:${summary.externalId})`);
    console.log(`  mastra_messages:             ${r.mastraMessages} rows deleted`);
    console.log(`  mastra_threads:              ${r.mastraThreads} rows deleted`);
    console.log(`  mastra_resources:            ${r.mastraResources} rows deleted`);
    console.log(`  mastra_workflow_snapshot:    ${r.mastraWorkflowSnapshots} rows deleted`);
    console.log(`  mastra_observational_memory: ${r.mastraObservationalMemory} rows deleted`);
    console.log(`  pgboss.job (brand-scoped):   ${r.pgBossJobs} rows deleted`);
    console.log(
      `  brands (cascades to brand_channels/conversations/post_drafts/workflow_runs): ${r.brand} row deleted`,
    );
    console.log(`Done. Send any new message on this channel to start onboarding from scratch.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
