import { eq, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { igSessions, type IgSession, type IgSessionStatus } from '../schema.js';

export const DUFFY_IG_SESSION_ID = 'duffy';

export async function getIgSession(id: string = DUFFY_IG_SESSION_ID): Promise<IgSession | null> {
  const db = getDb();
  const rows = await db.select().from(igSessions).where(eq(igSessions.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Insert or replace the storage state for a given session id (default `duffy`).
 * Used by the bootstrap CLI after a successful manual login + 2FA.
 */
export async function upsertIgSession(args: {
  id?: string;
  storageState: unknown;
  status: IgSessionStatus;
}): Promise<IgSession> {
  const db = getDb();
  const id = args.id ?? DUFFY_IG_SESSION_ID;
  const rows = await db
    .insert(igSessions)
    .values({
      id,
      storageStateJson: args.storageState,
      status: args.status,
      lastVerifiedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: igSessions.id,
      set: {
        storageStateJson: args.storageState,
        status: args.status,
        lastVerifiedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!rows[0]) throw new Error(`Failed to upsert ig_sessions row id=${id}`);
  return rows[0];
}

/**
 * Mark a session as invalid so the next capture attempt short-circuits to
 * the Apify fallback instead of hitting IG's challenge page repeatedly. Ops
 * re-runs the bootstrap script to recover.
 */
export async function markIgSessionInvalid(
  id: string = DUFFY_IG_SESSION_ID,
): Promise<void> {
  const db = getDb();
  await db
    .update(igSessions)
    .set({ status: 'invalid', updatedAt: sql`now()` })
    .where(eq(igSessions.id, id));
}
