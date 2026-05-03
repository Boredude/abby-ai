import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getGeneration } from '../../db/repositories/draftGenerations.js';
import { findDraftById } from '../../db/repositories/postDrafts.js';
import { getContentType } from '../../services/creative/registry.js';
import type { StepId } from '../../services/creative/types.js';

/**
 * Snapshot of a creative run for the director agent. One tool call returns
 * everything it needs to pick the next step: the content-type pipeline, the
 * list of completed steps (with their artifacts), the list of missing steps
 * (those still to run), the brief hint, and any edit-history breadcrumbs
 * from prior iterations.
 *
 * Keeping this in a single tool (vs. "get pipeline" + "get artifacts" + "get
 * brief") keeps the director's per-turn tool budget low — the whole plan is
 * one read.
 */
export const loadCreativeRunTool = createTool({
  id: 'loadCreativeRun',
  description:
    "Load the current creative run for a draft: the content-type pipeline, which steps are already done, which are still missing (with their assigned sub-agent), the briefing hint, and any edit history. Call this FIRST to decide what to delegate next.",
  inputSchema: z.object({
    draftId: z.string(),
  }),
  outputSchema: z.object({
    draftId: z.string(),
    brandId: z.string(),
    contentTypeId: z.string(),
    briefingHint: z.string().nullable(),
    pipeline: z.array(
      z.object({
        id: z.string(),
        agentName: z.string(),
        dependsOn: z.array(z.string()),
        description: z.string(),
      }),
    ),
    completedSteps: z.array(
      z.object({
        id: z.string(),
        artifact: z.unknown(),
      }),
    ),
    missingSteps: z.array(
      z.object({
        id: z.string(),
        agentName: z.string(),
        dependsOnReady: z.boolean(),
      }),
    ),
    editHistory: z.array(
      z.object({
        at: z.string(),
        note: z.string(),
        invalidated: z.array(z.string()),
      }),
    ),
  }),
  execute: async ({ draftId }) => {
    const draft = await findDraftById(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);

    const generation = await getGeneration(draftId);
    if (!generation) {
      throw new Error(
        `Draft ${draftId} has no generation blob — the pipeline must be initialised before agents are invoked.`,
      );
    }

    const contentType = getContentType(generation.contentTypeId);
    const completedIds = new Set<string>(Object.keys(generation.steps));

    const completedSteps: Array<{ id: string; artifact: unknown }> = [];
    for (const step of contentType.pipeline) {
      if (completedIds.has(step.id)) {
        completedSteps.push({
          id: step.id,
          artifact: (generation.steps as Record<string, unknown>)[step.id],
        });
      }
    }

    const missingSteps = contentType.pipeline
      .filter((s) => !completedIds.has(s.id))
      .map((s) => ({
        id: s.id,
        agentName: s.agentName,
        dependsOnReady: s.dependsOn.every((d) => completedIds.has(d as StepId)),
      }));

    return {
      draftId,
      brandId: draft.brandId,
      contentTypeId: generation.contentTypeId,
      briefingHint: extractBriefingHint(generation.editHistory),
      pipeline: contentType.pipeline.map((s) => ({
        id: s.id,
        agentName: s.agentName,
        dependsOn: s.dependsOn as string[],
        description: s.description,
      })),
      completedSteps,
      missingSteps,
      editHistory: generation.editHistory,
    };
  },
});

/**
 * Helper: pull the most recent edit note out of history so the director
 * can include it as extra context when delegating the rerun. Returns null
 * on first-run drafts. The full history is still available on the tool's
 * output for the director if it needs to reason about prior iterations.
 */
function extractBriefingHint(
  editHistory: ReadonlyArray<{ at: string; note: string; invalidated: string[] }>,
): string | null {
  if (editHistory.length === 0) return null;
  const latest = editHistory[editHistory.length - 1];
  return latest?.note ?? null;
}
