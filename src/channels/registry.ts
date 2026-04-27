import { findPrimaryChannelForBrand } from '../db/repositories/brandChannels.js';
import type { ChannelKind } from '../db/schema.js';
import type { BoundChannel, Channel } from './types.js';
import { whatsAppChannel } from './whatsapp/WhatsAppChannel.js';

/**
 * Returns the singleton `Channel` adapter for a given kind. Throws if the
 * kind isn't implemented yet — caller should have checked the brand's
 * connected channels first.
 */
export function getChannel(kind: ChannelKind): Channel {
  switch (kind) {
    case 'whatsapp':
      return whatsAppChannel();
    case 'sms':
    case 'telegram':
    case 'instagram':
    case 'tiktok':
      throw new Error(`Channel kind "${kind}" is not implemented yet`);
  }
}

/**
 * Resolves a brand's preferred channel (primary, optionally filtered by kind)
 * into a `BoundChannel` ready to send messages on. Returns null if the brand
 * has no matching channel.
 */
export async function getBrandChannel(
  brandId: string,
  kind?: ChannelKind,
): Promise<BoundChannel | null> {
  const row = await findPrimaryChannelForBrand(brandId, kind);
  if (!row) return null;
  return getChannel(row.kind).bind(row.externalId);
}

/**
 * Same as `getBrandChannel` but throws if not found — for code paths where
 * we already know the brand has a channel (e.g. the brand was just upserted
 * from an inbound webhook on that very channel).
 */
export async function requireBrandChannel(
  brandId: string,
  kind?: ChannelKind,
): Promise<BoundChannel> {
  const channel = await getBrandChannel(brandId, kind);
  if (!channel) {
    throw new Error(
      `Brand ${brandId} has no ${kind ? `${kind} ` : ''}channel connected`,
    );
  }
  return channel;
}
