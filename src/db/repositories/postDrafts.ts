import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { postDrafts, type PostDraft, type NewPostDraft, type EditNote } from '../schema.js';

export async function createPostDraft(input: NewPostDraft): Promise<PostDraft> {
  const db = getDb();
  const rows = await db.insert(postDrafts).values(input).returning();
  if (!rows[0]) throw new Error('Failed to create post draft');
  return rows[0];
}

export async function findDraftById(id: string): Promise<PostDraft | null> {
  const db = getDb();
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateDraftStatus(
  id: string,
  status: PostDraft['status'],
  patch: Partial<{
    scheduledAt: Date | null;
    error: string | null;
    caption: string;
    mediaUrls: string[];
  }> = {},
): Promise<PostDraft> {
  const db = getDb();
  const rows = await db
    .update(postDrafts)
    .set({ status, ...patch, updatedAt: sql`now()` })
    .where(eq(postDrafts.id, id))
    .returning();
  if (!rows[0]) throw new Error(`Draft ${id} not found`);
  return rows[0];
}

export async function appendEditNote(id: string, note: EditNote): Promise<PostDraft> {
  const db = getDb();
  const rows = await db
    .update(postDrafts)
    .set({
      editNotes: sql`coalesce(${postDrafts.editNotes}, '[]'::jsonb) || ${JSON.stringify([note])}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(postDrafts.id, id))
    .returning();
  if (!rows[0]) throw new Error(`Draft ${id} not found`);
  return rows[0];
}

export async function listPendingApprovalsForBrand(brandId: string): Promise<PostDraft[]> {
  const db = getDb();
  return db
    .select()
    .from(postDrafts)
    .where(and(eq(postDrafts.brandId, brandId), eq(postDrafts.status, 'pending_approval')));
}

/**
 * Drafts in `pending_approval` status that haven't been touched for > `olderThanHours`,
 * used by the reminder cron to nudge brand owners.
 */
export async function listStalePendingApprovals(olderThanHours: number): Promise<PostDraft[]> {
  const db = getDb();
  return db
    .select()
    .from(postDrafts)
    .where(
      and(
        eq(postDrafts.status, 'pending_approval'),
        sql`${postDrafts.updatedAt} < now() - make_interval(hours => ${olderThanHours})`,
      ),
    );
}
