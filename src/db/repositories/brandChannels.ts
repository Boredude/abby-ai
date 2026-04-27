import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import {
  brandChannels,
  brands,
  type Brand,
  type BrandChannel,
  type ChannelKind,
} from '../schema.js';

export async function findBrandChannel(
  kind: ChannelKind,
  externalId: string,
): Promise<BrandChannel | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(brandChannels)
    .where(and(eq(brandChannels.kind, kind), eq(brandChannels.externalId, externalId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listBrandChannels(brandId: string): Promise<BrandChannel[]> {
  const db = getDb();
  return db.select().from(brandChannels).where(eq(brandChannels.brandId, brandId));
}

export async function findPrimaryChannelForBrand(
  brandId: string,
  kind?: ChannelKind,
): Promise<BrandChannel | null> {
  const db = getDb();
  const conditions = kind
    ? and(eq(brandChannels.brandId, brandId), eq(brandChannels.kind, kind))
    : eq(brandChannels.brandId, brandId);
  const rows = await db.select().from(brandChannels).where(conditions);
  if (rows.length === 0) return null;
  return rows.find((r) => r.isPrimary) ?? rows[0]!;
}

/**
 * Resolves an inbound message to a brand: looks up `(kind, externalId)` in
 * `brand_channels`; if found, returns that brand. Otherwise creates a new
 * brand with `status='pending'` and a `brand_channels` row pointing at it
 * (marked primary for that kind), in a single transaction.
 *
 * This is the channel-aware replacement for the old `upsertBrandByPhone`.
 */
export async function upsertBrandByChannel(input: {
  kind: ChannelKind;
  externalId: string;
}): Promise<{ brand: Brand; channel: BrandChannel; created: boolean }> {
  const db = getDb();
  const existingChannel = await findBrandChannel(input.kind, input.externalId);
  if (existingChannel) {
    const brandRows = await db
      .select()
      .from(brands)
      .where(eq(brands.id, existingChannel.brandId))
      .limit(1);
    const brand = brandRows[0];
    if (!brand) {
      // Channel orphan: brand was deleted but channel row survived (shouldn't
      // happen because of cascade, but defensive). Recreate.
      await db.delete(brandChannels).where(eq(brandChannels.id, existingChannel.id));
    } else {
      return { brand, channel: existingChannel, created: false };
    }
  }

  return db.transaction(async (tx) => {
    const [brand] = await tx.insert(brands).values({}).returning();
    if (!brand) throw new Error('Failed to insert brand');
    const [channel] = await tx
      .insert(brandChannels)
      .values({
        brandId: brand.id,
        kind: input.kind,
        externalId: input.externalId,
        isPrimary: true,
      })
      .returning();
    if (!channel) throw new Error('Failed to insert brand_channel');
    return { brand, channel, created: true };
  });
}

export async function setBrandChannelStatus(
  id: string,
  status: BrandChannel['status'],
): Promise<BrandChannel> {
  const db = getDb();
  const rows = await db
    .update(brandChannels)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(brandChannels.id, id))
    .returning();
  if (!rows[0]) throw new Error(`brand_channel ${id} not found`);
  return rows[0];
}
