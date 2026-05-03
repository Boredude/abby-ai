import { logger } from '../../config/logger.js';
import {
  createPostDraft,
  findDraftById,
  updateDraftStatus,
} from '../../db/repositories/postDrafts.js';
import {
  getGeneration,
  initGeneration,
  invalidateSteps,
} from '../../db/repositories/draftGenerations.js';
import { getCreativeDirectorAgent } from '../../mastra/agents/creativeDirector.js';
import { memoryFor } from '../../mastra/memory.js';
import { expandInvalidatedSteps, getContentType } from './registry.js';
import type { EditDirective, PostDraftGeneration, StepId } from './types.js';

/**
 * Run the creative pipeline for a post.
 *
 * This is the single entry point the workflow (or any caller) uses. It:
 *   1. Creates or loads the `post_drafts` row, stamps it `draft`.
 *   2. Initialises the `generation` blob for the chosen contentType. On a
 *      rerun with an `editDirective`, it invalidates the listed steps +
 *      their downstream dependents.
 *   3. Invokes the creativeDirector agent on the brand's shared memory
 *      thread. The director delegates each missing step to its specialist
 *      and stops when every step has an artifact.
 *   4. Reads the finalised artifacts, hands them to the contentType's
 *      `toPostDraft` assembler, and writes caption + mediaUrls onto the
 *      draft row.
 *
 * The model-facing logic lives entirely inside the agents. This service is
 * deterministic plumbing: DB, orchestration, assembly.
 */

export type RunCreativePipelineInput = {
  brandId: string;
  contentTypeId: string;
  scheduledAt?: Date;
  briefingHint?: string;
  existingDraftId?: string;
  editDirective?: EditDirective;
};

export type RunCreativePipelineResult = {
  draftId: string;
  caption: string;
  mediaUrls: string[];
  imageUrl: string;
  generation: PostDraftGeneration;
};

export async function runCreativePipeline(
  input: RunCreativePipelineInput,
): Promise<RunCreativePipelineResult> {
  const log = logger.child({
    brandId: input.brandId,
    contentTypeId: input.contentTypeId,
    existingDraftId: input.existingDraftId,
  });

  const contentType = getContentType(input.contentTypeId);

  // 1. Acquire (or create) the draft row. The creative pipeline always
  // operates on a persisted draft so agents have a stable draftId to attach
  // artifacts to.
  let draftId: string;
  if (input.existingDraftId) {
    const existing = await findDraftById(input.existingDraftId);
    if (!existing) throw new Error(`Draft ${input.existingDraftId} not found`);
    draftId = existing.id;
    await updateDraftStatus(draftId, 'draft');
  } else {
    const created = await createPostDraft({
      brandId: input.brandId,
      caption: '',
      mediaUrls: [],
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      status: 'draft',
    });
    draftId = created.id;
  }

  // 2. Initialise the generation blob. For a brand-new draft we start
  // clean. For a rerun with an edit directive we keep history + just drop
  // the invalidated steps (with downstream expansion).
  if (input.existingDraftId && input.editDirective) {
    await initGeneration(draftId, { contentTypeId: contentType.id, reset: false });
    const expanded = expandInvalidatedSteps(
      contentType,
      input.editDirective.invalidate,
    );
    if (expanded.length > 0) {
      await invalidateSteps(draftId, {
        steps: expanded,
        note: input.editDirective.note,
      });
    }
  } else {
    await initGeneration(draftId, { contentTypeId: contentType.id, reset: true });
  }

  // 3. Hand the baton to the director. The prompt is intentionally tiny:
  // everything it needs comes from `loadCreativeRun`, which reads exactly
  // what we just wrote above.
  const director = getCreativeDirectorAgent();
  const directorPrompt = [
    `Run the creative pipeline for draftId=${draftId} (brandId=${input.brandId}).`,
    `ContentType: ${contentType.id}.`,
    input.briefingHint ? `Briefing hint: ${input.briefingHint}` : null,
    input.editDirective
      ? `Edit directive note: ${input.editDirective.note}. Steps already invalidated: ${input.editDirective.invalidate.join(', ') || '(none)'}. Re-run missing steps only.`
      : null,
    `Follow your instructions exactly. Do not skip or reorder steps.`,
  ]
    .filter(Boolean)
    .join('\n');

  log.info({ draftId }, 'runCreativePipeline: invoking creativeDirector');
  await director.generate(directorPrompt, { memory: memoryFor(input.brandId) });

  // 4. Assemble. If any step is missing an artifact at this point, the
  // director failed or the sub-agents short-circuited — fail loudly rather
  // than shipping a partial post.
  const finalGeneration = await getGeneration(draftId);
  if (!finalGeneration) throw new Error(`Draft ${draftId} has no generation after run`);
  const missing = contentType.pipeline
    .map((s) => s.id)
    .filter((id) => !(id in finalGeneration.steps));
  if (missing.length > 0) {
    await updateDraftStatus(draftId, 'draft', {
      error: `Creative pipeline ended with missing artifacts: ${missing.join(', ')}`,
    });
    throw new Error(
      `Creative pipeline did not produce all required artifacts for draft ${draftId}. Missing: ${missing.join(', ')}`,
    );
  }

  const assembled = contentType.toPostDraft(finalGeneration.steps);
  const firstImage = assembled.mediaUrls[0];
  if (!firstImage) {
    throw new Error(`Creative pipeline produced no media for draft ${draftId}`);
  }

  await updateDraftStatus(draftId, 'draft', {
    caption: assembled.caption,
    mediaUrls: assembled.mediaUrls,
    error: null,
  });

  log.info({ draftId }, 'runCreativePipeline: complete');
  return {
    draftId,
    caption: assembled.caption,
    mediaUrls: assembled.mediaUrls,
    imageUrl: firstImage,
    generation: finalGeneration,
  };
}

/**
 * Re-export for workflow callers that need the step-id type when building
 * an `EditDirective` without pulling the whole types barrel.
 */
export type { StepId };
