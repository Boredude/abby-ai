import { logger } from '../config/logger.js';
import { getPool } from '../db/client.js';
import { resetBrandByPhone } from './admin/resetBrandState.js';
import { sendText } from './kapso/client.js';
import type { ParsedInboundMessage } from './kapso/inboundParser.js';

const HELP_LINES = [
  'Commands you can send me:',
  '/reset — wipe my memory and your brand profile, start fresh',
  '/help — show this list',
];

export type SlashCommand = { command: string; args: string[] };

/**
 * Returns true if `parsed` is a text message whose body starts with `/`.
 * Buttons and images are never slash commands.
 */
export function isSlashCommand(parsed: ParsedInboundMessage): parsed is ParsedInboundMessage & {
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
 * Handles a slash command coming in over WhatsApp. Always replies to the user
 * (even on unknown commands) so the user gets immediate feedback.
 */
export async function handleSlashCommand(
  parsed: ParsedInboundMessage & { kind: 'text' },
): Promise<void> {
  const cmd = parseSlashCommand(parsed.text);
  if (!cmd) return;

  const log = logger.child({ fromPhone: parsed.fromPhone, command: cmd.command });

  switch (cmd.command) {
    case 'reset': {
      log.info('Slash command: /reset');
      try {
        const summary = await resetBrandByPhone(getPool(), parsed.fromPhone);
        if (!summary.brandId) {
          await sendText(
            parsed.fromPhone,
            "Nothing to reset — I don't have any record of you yet. Send me anything to get started.",
          );
          return;
        }
        const total = Object.values(summary.rowsDeleted).reduce((acc, n) => acc + n, 0);
        log.info({ summary }, 'Slash command: /reset complete');
        await sendText(
          parsed.fromPhone,
          `Slate wiped (${total} rows). I won't remember anything from before. Send me a message to start onboarding fresh.`,
        );
      } catch (err) {
        log.error({ err }, 'Slash command: /reset failed');
        await sendText(
          parsed.fromPhone,
          "Couldn't reset just now — something went sideways on my end. Try again in a moment.",
        );
      }
      return;
    }

    case 'help': {
      log.info('Slash command: /help');
      await sendText(parsed.fromPhone, HELP_LINES.join('\n'));
      return;
    }

    default: {
      log.info('Slash command: unknown');
      await sendText(
        parsed.fromPhone,
        `Unknown command: /${cmd.command}\n\n${HELP_LINES.join('\n')}`,
      );
    }
  }
}
