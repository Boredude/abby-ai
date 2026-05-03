import { getChannel } from '../channels/registry.js';
import type { ChannelMessage } from '../channels/types.js';
import { logger } from '../config/logger.js';
import { getPool } from '../db/client.js';
import { upsertBrandByChannel } from '../db/repositories/brandChannels.js';
import { findActiveRunForBrand } from '../db/repositories/workflowRuns.js';
import { resetBrandByChannel } from './admin/resetBrandState.js';
import { startWorkflow } from './workflowRunner.js';

const HELP_LINES = [
  'Commands you can send me:',
  '/post [topic] — draft a new Instagram post (I\'ll ask for a topic if you skip one)',
  '/reset — wipe everything (memory, brand profile, brand kit, scheduled posts) and start over',
  '/help — show this list',
];

export type SlashCommand = { command: string; args: string[] };

/**
 * Returns true if `parsed` is a text message whose body starts with `/`.
 * Buttons and images are never slash commands.
 */
export function isSlashCommand(parsed: ChannelMessage): parsed is ChannelMessage & {
  kind: 'text';
} {
  return parsed.kind === 'text' && parsed.text.trim().startsWith('/');
}

export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...args] = trimmed.split(/\s+/);
  return { command: head!.slice(1).toLowerCase(), args };
}

/**
 * Free-text briefing extracted from a slash command body. For `/post`, we
 * want to preserve the user's original phrasing (casing, punctuation) —
 * not the lower-cased command itself. So we re-slice from the original
 * text instead of re-joining `cmd.args`.
 */
function extractArgsText(rawText: string): string {
  const trimmed = rawText.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return '';
  return trimmed.slice(firstSpace + 1).trim();
}

/**
 * Handles a slash command coming in over any channel. Always replies to the
 * user (even on unknown commands) so they get immediate feedback.
 */
export async function handleSlashCommand(
  parsed: ChannelMessage & { kind: 'text' },
): Promise<void> {
  const cmd = parseSlashCommand(parsed.text);
  if (!cmd) return;

  const log = logger.child({
    channel: parsed.channelKind,
    externalUserId: parsed.externalUserId,
    command: cmd.command,
  });
  const channel = getChannel(parsed.channelKind).bind(parsed.externalUserId);

  switch (cmd.command) {
    case 'reset': {
      log.info('Slash command: /reset');
      try {
        const summary = await resetBrandByChannel(getPool(), {
          kind: parsed.channelKind,
          externalId: parsed.externalUserId,
        });
        if (!summary.brandId) {
          await channel.sendText(
            "Nothing to reset — I don't have any record of you yet. Send me anything to get started.",
          );
          return;
        }
        const total = Object.values(summary.rowsDeleted).reduce((acc, n) => acc + n, 0);
        log.info({ summary }, 'Slash command: /reset complete');
        await channel.sendText(
          `Slate wiped (${total} rows) — memory, brand profile, brand kit, scheduled posts, all gone. Send me a message to start onboarding from scratch.`,
        );
      } catch (err) {
        log.error({ err }, 'Slash command: /reset failed');
        await channel.sendText(
          "Couldn't reset just now — something went sideways on my end. Try again in a moment.",
        );
      }
      return;
    }

    case 'post': {
      log.info('Slash command: /post');
      try {
        const { brand } = await upsertBrandByChannel({
          kind: parsed.channelKind,
          externalId: parsed.externalUserId,
        });

        // Gate: `/post` only makes sense for an onboarded brand. Before the
        // brand kit + voice exist, the creative pipeline has nothing to
        // ground on.
        if (brand.status === 'pending' || brand.status === 'onboarding') {
          await channel.sendText(
            "Let's finish setting up your brand first — tell me your Instagram handle and I'll build your kit. Then /post will work.",
          );
          return;
        }
        if (brand.status === 'paused') {
          await channel.sendText(
            "Your account is paused. Send me anything to resume, then try /post again.",
          );
          return;
        }

        // One workflow at a time per brand. If the user is already mid-review
        // for another draft, don't start a second run — the inbound resume
        // routing assumes exactly one suspended workflow.
        const existing = await findActiveRunForBrand(brand.id);
        if (existing) {
          await channel.sendText(
            "You've already got a draft waiting on your reply — let's finish that one first (approve / edit / reject), or send /reset to start over.",
          );
          return;
        }

        const briefingHint = extractArgsText(parsed.text);
        await startWorkflow({
          workflowId: 'startPost',
          brandId: brand.id,
          inputData: {
            brandId: brand.id,
            ...(briefingHint ? { briefingHint } : {}),
          },
        });
        log.info({ hasBrief: !!briefingHint }, 'Slash command: /post started');
      } catch (err) {
        log.error({ err }, 'Slash command: /post failed');
        await channel.sendText(
          "Couldn't spin up a new post just now — something went sideways on my end. Try again in a moment.",
        );
      }
      return;
    }

    case 'help': {
      log.info('Slash command: /help');
      await channel.sendText(HELP_LINES.join('\n'));
      return;
    }

    default: {
      log.info('Slash command: unknown');
      await channel.sendText(`Unknown command: /${cmd.command}\n\n${HELP_LINES.join('\n')}`);
    }
  }
}
