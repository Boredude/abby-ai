import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireBrandChannel } from '../../channels/registry.js';
import type { BoundChannel, ChannelButton } from '../../channels/types.js';
import { logger } from '../../config/logger.js';
import { channelKindEnum } from '../../db/schema.js';

const channelKindSchema = z.enum(channelKindEnum.enumValues);
const messageTypeSchema = z.enum(['text', 'image', 'buttons', 'imageWithButtons']);

const buttonSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(20),
});

async function sendButtonsCapabilityAware(
  channel: BoundChannel,
  args: { bodyText: string; footer?: string; buttons: ChannelButton[] },
): Promise<void> {
  if (channel.capabilities.supportsButtons) {
    await channel.sendButtons(args);
    return;
  }
  // Fallback for channels without native interactive buttons (SMS/Telegram-text).
  const numbered = args.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  await channel.sendText(`${args.bodyText}\n\n${numbered}\n\nReply with a number.`);
}

export const sendChannelMessageTool = createTool({
  id: 'sendChannelMessage',
  description: `Actively send a message to the brand on their primary channel. Use for IMAGES, BUTTON prompts, or when you need to send MULTIPLE messages in one turn (e.g. an image followed by a follow-up question). For a normal text-only reply, just RETURN your response — the platform will send it automatically; do NOT call this tool for that.`,
  inputSchema: z.object({
    brandId: z.string().describe('The brand to send to. Pull from your conversation context.'),
    type: messageTypeSchema,
    body: z
      .string()
      .optional()
      .describe('Message body. Required for text/buttons/imageWithButtons; used as caption for image.'),
    imageUrl: z
      .string()
      .url()
      .optional()
      .describe('Public image URL. Required for image and imageWithButtons.'),
    footer: z.string().max(60).optional(),
    buttons: z
      .array(buttonSchema)
      .min(1)
      .max(3)
      .optional()
      .describe('1–3 reply buttons. Required for buttons and imageWithButtons.'),
    channelKind: channelKindSchema
      .optional()
      .describe('Optional override of which connected channel to send on. Defaults to the brand\'s primary channel.'),
  }),
  outputSchema: z.object({
    sent: z.literal(true),
    type: messageTypeSchema,
    channelKind: channelKindSchema,
  }),
  execute: async (input) => {
    const channel = await requireBrandChannel(input.brandId, input.channelKind);
    logger.info(
      { brandId: input.brandId, channelKind: channel.kind, type: input.type },
      'sendChannelMessage: sending',
    );

    switch (input.type) {
      case 'text': {
        if (!input.body) throw new Error('sendChannelMessage(text): body is required');
        await channel.sendText(input.body);
        return { sent: true as const, type: input.type, channelKind: channel.kind };
      }
      case 'image': {
        if (!input.imageUrl) throw new Error('sendChannelMessage(image): imageUrl is required');
        await channel.sendImage(input.imageUrl, input.body);
        return { sent: true as const, type: input.type, channelKind: channel.kind };
      }
      case 'buttons': {
        if (!input.body) throw new Error('sendChannelMessage(buttons): body is required');
        if (!input.buttons?.length)
          throw new Error('sendChannelMessage(buttons): at least 1 button is required');
        await sendButtonsCapabilityAware(channel, {
          bodyText: input.body,
          ...(input.footer ? { footer: input.footer } : {}),
          buttons: input.buttons,
        });
        return { sent: true as const, type: input.type, channelKind: channel.kind };
      }
      case 'imageWithButtons': {
        if (!input.imageUrl)
          throw new Error('sendChannelMessage(imageWithButtons): imageUrl is required');
        if (!input.body)
          throw new Error('sendChannelMessage(imageWithButtons): body is required');
        if (!input.buttons?.length)
          throw new Error('sendChannelMessage(imageWithButtons): at least 1 button is required');
        if (channel.capabilities.supportsImageWithButtons) {
          await channel.sendImageWithButtons({
            imageUrl: input.imageUrl,
            bodyText: input.body,
            ...(input.footer ? { footer: input.footer } : {}),
            buttons: input.buttons,
          });
        } else {
          // Capability fallback: split into image + buttons (or text fallback).
          await channel.sendImage(input.imageUrl, input.body);
          await sendButtonsCapabilityAware(channel, {
            bodyText: 'Pick one:',
            ...(input.footer ? { footer: input.footer } : {}),
            buttons: input.buttons,
          });
        }
        return { sent: true as const, type: input.type, channelKind: channel.kind };
      }
    }
  },
});
