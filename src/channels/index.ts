export type {
  BoundChannel,
  Channel,
  ChannelButton,
  ChannelCapabilities,
  ChannelKind,
  ChannelMessage,
  ChannelMessageBase,
  SendButtonsArgs,
  SendImageWithButtonsArgs,
} from './types.js';

export { getBrandChannel, getChannel, requireBrandChannel } from './registry.js';
export { whatsAppChannel } from './whatsapp/WhatsAppChannel.js';
