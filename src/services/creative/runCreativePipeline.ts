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
import { runCreativeStep } from './runCreativeStep.js';
import { expandInvalidatedSteps, getContentType } from './registry.js';
import type {
  EditDirective,
  PostDraftGeneration,
  StepArtifacts,
  StepId,
} from './types.js';

/**
 * Run the creative pipeline for a post.
 *
 * Single entry point used by the workflow (or any caller). It:
 *   1. Creates or loads the `post_drafts` row, stamps it `draft`.
 *   2. Initialises the `generation` blob for the chosen contentType. On a
 *      rerun with an `editDirective`, it invalidates the listed steps +
 *      their downstream dependents.
 *   3. Walks the contentType pipeline in declared order. Each missing step
 *      is dispatched to `runCreativeStep`, which calls the right specialist
 *      (with a structured-output schema for text steps; deterministic image
 *      render for the image step) and persists the artifact.
 *   4. Reads the finalised artifacts, hands them to the contentType's
 *      `toPostDraft` assembler, and writes caption + mediaUrls onto the
 *      draft row.
 *
 * Orchestration is deterministic on purpose — the pipeline DAG already lives
 * in the contentType definition, so there's nothing for an LLM director to
 * decide. Removing the orchestrator agent removes a class of "the model
 * forgot to call the next step" bugs.
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
  // operates on a persisted draft so each step has a stable draftId.
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

  // 3. Walk the pipeline. We re-read the generation between steps so
  // dependency artifacts are fresh — important for the edit loop where a
  // partial set of artifacts is preserved across runs.
  const briefingHint = input.briefingHint ?? input.editDirective?.note;
  for (const step of contentType.pipeline) {
    const generation = await getGeneration(draftId);
    if (!generation) {
      throw new Error(`Draft ${draftId} lost its generation blob mid-run`);
    }
    if (step.id in generation.steps) continue; // already done (rerun case)
    log.info({ draftId, stepId: step.id }, 'runCreativePipeline: running step');
    await runCreativeStep({
      draftId,
      brandId: input.brandId,
      stepId: step.id as StepId,
      ...(briefingHint ? { briefingHint } : {}),
      artifacts: generation.steps as StepArtifacts,
    });
  }

  // 4. Assemble. If anything is somehow still missing (a step threw and
  // we're being defensive), surface it loudly rather than ship a partial
  // post.
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
