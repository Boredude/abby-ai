import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { setStepArtifact } from '../../db/repositories/draftGenerations.js';
import { stepArtifactInputSchema } from '../../services/creative/types.js';

/**
 * The single write-surface for specialist sub-agents to commit their work
 * in the creative pipeline. Every sub-agent MUST call this exactly once per
 * run with a payload that matches its step's artifact schema. The input is
 * a discriminated union by `step`, so an agent calling with the wrong step
 * (e.g. copywriter trying to emit a hashtag artifact) is rejected at the
 * schema layer, not at runtime.
 *
 * The tool is intentionally tiny on purpose — it's how the director knows a
 * step is "done" (artifact written to `post_drafts.generation.steps[step]`).
 */
export const saveStepArtifactTool = createTool({
  id: 'saveStepArtifact',
  description:
    "Commit this step's finished artifact to the draft. Call this EXACTLY ONCE after you've produced your output. The `step` field must match your role (ideation/copy/hashtags/artDirection/image) and the `artifact` must match that step's schema. Returns the updated list of completed steps.",
  inputSchema: z.object({
    draftId: z.string().describe('The post_drafts.id being generated for this run.'),
    step: z.enum(['ideation', 'copy', 'hashtags', 'artDirection', 'image']),
    artifact: z.unknown().describe("Step-specific artifact payload. Must match the step's schema."),
  }),
  outputSchema: z.object({
    draftId: z.string(),
    step: z.string(),
    completedSteps: z.array(z.string()),
  }),
  execute: async ({ draftId, step, artifact }) => {
    const parsed = stepArtifactInputSchema.safeParse({ step, artifact });
    if (!parsed.success) {
      throw new Error(
        `saveStepArtifact: artifact does not match schema for step '${step}'. Issues: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const generation = await setStepArtifact(draftId, parsed.data);
    logger.info(
      { draftId, step, completedSteps: Object.keys(generation.steps) },
      'saveStepArtifact: committed artifact',
    );
    return {
      draftId,
      step,
      completedSteps: Object.keys(generation.steps),
    };
  },
});
