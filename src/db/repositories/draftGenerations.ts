import { eq, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { postDrafts } from '../schema.js';
import {
  postDraftGenerationSchema,
  stepIdSchema,
  type PostDraftGeneration,
  type StepArtifactInput,
  type StepArtifacts,
  type StepId,
} from '../../services/creative/types.js';

/**
 * Repository for the `post_drafts.generation` blob. Centralizes:
 *   - initialisation of the blob for a freshly-created draft,
 *   - atomic per-step artifact writes (the creative pipeline calls
 *     `setStepArtifact` after each step's specialist returns),
 *   - invalidation of a set of step ids + an `editHistory` breadcrumb so the
 *     approval loop can explain to itself why those steps are missing.
 *
 * Downstream-dependency expansion is a concern of the content-type graph,
 * not the repository — callers pass in the already-expanded list.
 */

function parseGeneration(raw: unknown, fallbackContentTypeId: string): PostDraftGeneration {
  if (raw === null || raw === undefined) {
    return { contentTypeId: fallbackContentTypeId, steps: {}, editHistory: [] };
  }
  const parsed = postDraftGenerationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `post_drafts.generation is malformed: ${parsed.error.message}. Raw: ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }
  return parsed.data;
}

export async function getGeneration(
  draftId: string,
): Promise<PostDraftGeneration | null> {
  const db = getDb();
  const rows = await db
    .select({ generation: postDrafts.generation })
    .from(postDrafts)
    .where(eq(postDrafts.id, draftId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.generation === null || row.generation === undefined) return null;
  return parseGeneration(row.generation, '');
}

/**
 * Initialise (or re-initialise) the generation blob for a draft. Safe to
 * call on an existing draft — it preserves `editHistory` but resets steps
 * to `{}` when `reset` is true (used when the user re-briefs from scratch).
 */
export async function initGeneration(
  draftId: string,
  opts: { contentTypeId: string; reset?: boolean },
): Promise<PostDraftGeneration> {
  const db = getDb();
  const existing = await getGeneration(draftId);
  const base: PostDraftGeneration = existing
    ? {
        contentTypeId: opts.contentTypeId,
        steps: opts.reset ? {} : existing.steps,
        editHistory: existing.editHistory,
      }
    : { contentTypeId: opts.contentTypeId, steps: {}, editHistory: [] };

  const rows = await db
    .update(postDrafts)
    .set({ generation: base, updatedAt: sql`now()` })
    .where(eq(postDrafts.id, draftId))
    .returning({ generation: postDrafts.generation });
  if (!rows[0]) throw new Error(`Draft ${draftId} not found`);
  return parseGeneration(rows[0].generation, opts.contentTypeId);
}

/**
 * Write a single step's artifact. The `StepArtifactInput` discriminated
 * union guarantees the artifact shape matches the step id, which is the
 * only contract the sub-agents need to honour.
 *
 * Uses a SQL `jsonb_set` so two steps that finish concurrently don't
 * overwrite each other's artifacts — important once we fan out (image
 * and copy run independently in the same run).
 */
export async function setStepArtifact(
  draftId: string,
  input: StepArtifactInput,
): Promise<PostDraftGeneration> {
  const db = getDb();
  const artifactJson = JSON.stringify(input.artifact);
  const rows = await db
    .update(postDrafts)
    .set({
      generation: sql`jsonb_set(
        coalesce(${postDrafts.generation}, '{"contentTypeId":"","steps":{},"editHistory":[]}'::jsonb),
        ${`{steps,${input.step}}`}::text[],
        ${artifactJson}::jsonb,
        true
      )`,
      updatedAt: sql`now()`,
    })
    .where(eq(postDrafts.id, draftId))
    .returning({ generation: postDrafts.generation });
  if (!rows[0]) throw new Error(`Draft ${draftId} not found`);
  return parseGeneration(rows[0].generation, '');
}

/**
 * Drop the listed step artifacts and append an edit-history breadcrumb.
 * The caller is responsible for having already expanded the list via
 * `expandInvalidatedSteps` from the content-type registry.
 */
export async function invalidateSteps(
  draftId: string,
  args: { steps: readonly StepId[]; note: string },
): Promise<PostDraftGeneration> {
  const toDrop = Array.from(new Set(args.steps.map((s) => stepIdSchema.parse(s))));
  if (toDrop.length === 0) {
    const current = await getGeneration(draftId);
    if (!current) throw new Error(`Draft ${draftId} has no generation to invalidate`);
    return current;
  }
  const current = await getGeneration(draftId);
  if (!current) throw new Error(`Draft ${draftId} has no generation to invalidate`);

  const nextSteps: StepArtifacts = { ...current.steps };
  for (const s of toDrop) delete (nextSteps as Record<string, unknown>)[s];

  const next: PostDraftGeneration = {
    ...current,
    steps: nextSteps,
    editHistory: [
      ...current.editHistory,
      { at: new Date().toISOString(), note: args.note, invalidated: toDrop },
    ],
  };

  const db = getDb();
  const rows = await db
    .update(postDrafts)
    .set({ generation: next, updatedAt: sql`now()` })
    .where(eq(postDrafts.id, draftId))
    .returning({ generation: postDrafts.generation });
  if (!rows[0]) throw new Error(`Draft ${draftId} not found`);
  return parseGeneration(rows[0].generation, '');
}
