import { listBrandChannels } from '../db/repositories/brandChannels.js';
import { findBrandById } from '../db/repositories/brands.js';
import type { Brand, BrandChannel, ChannelKind } from '../db/schema.js';

/**
 * A coherent snapshot of everything we know about a brand at a single
 * point in time. Built once per request/dispatch and passed around
 * read-only — agents and tools should NEVER mutate the underlying objects;
 * persistence goes through repositories.
 *
 * Phase 1 scope: just the brand row + connected channels. Later phases add
 * helpers for voice/kit/onboarding state once those become richer.
 */
export type BrandContext = {
  brand: Brand;
  channels: BrandChannel[];
  primaryChannel: BrandChannel | null;
  channelByKind(kind: ChannelKind): BrandChannel | null;
};

function buildContext(brand: Brand, channels: BrandChannel[]): BrandContext {
  const primary = channels.find((c) => c.isPrimary) ?? channels[0] ?? null;
  return {
    brand,
    channels,
    primaryChannel: primary,
    channelByKind(kind) {
      const matches = channels.filter((c) => c.kind === kind);
      return matches.find((c) => c.isPrimary) ?? matches[0] ?? null;
    },
  };
}

export async function loadBrandContext(brandId: string): Promise<BrandContext | null> {
  const brand = await findBrandById(brandId);
  if (!brand) return null;
  const channels = await listBrandChannels(brandId);
  return buildContext(brand, channels);
}

export async function requireBrandContext(brandId: string): Promise<BrandContext> {
  const ctx = await loadBrandContext(brandId);
  if (!ctx) throw new Error(`Brand ${brandId} not found`);
  return ctx;
}
