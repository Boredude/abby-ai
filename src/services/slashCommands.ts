import { getChannel } from '../channels/registry.js';
import type { ChannelMessage } from '../channels/types.js';
import { logger } from '../config/logger.js';
import { getPool } from '../db/client.js';
import { resetBrandByChannel } from './admin/resetBrandState.js';

const HELP_LINES = [
  'Commands you can send me:',
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
