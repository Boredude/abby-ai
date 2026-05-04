import type { StepArtifacts, StepId } from '../types.js';

/**
 * A single step in a content-type pipeline. The step binds a stable `id`
 * (used as the artifact key in `post_drafts.generation.steps`) to the
 * specialist sub-agent that produces it and the upstream steps whose
 * artifacts it consumes.
 *
 * `dependsOn` captures the causal graph between steps. When an upstream
 * step is invalidated (user asks for "a different caption"), everything
 * downstream of it is automatically invalidated too (the hashtag set that
 * was tailored to the old caption, for example).
 *
 * `agentName` is the key of the Mastra specialist agent that produces this
 * step's artifact, when the step is model-driven. It is `null` for steps
 * that `runCreativeStep` handles deterministically (e.g. the image step,
 * which is a pure forward of the stylist's `imagePrompt` to the renderer).
 *
 * We intentionally don't import the agent-registry type here so the
 * content-type layer stays decoupled from Mastra wiring (trivial to test).
 */
export type PipelineStep = {
  id: StepId;
  agentName: string | null;
  dependsOn: readonly StepId[];
  description: string;
};

/**
 * Output of the final assembly step: what gets written onto the
 * `post_drafts` row once every pipeline step has produced its artifact.
 */
export type PostDraftOutput = {
  caption: string;
  mediaUrls: string[];
};

export type ContentType = {
  id: string;
  displayName: string;
  description: string;
  pipeline: readonly PipelineStep[];
  /**
   * Collapse the per-step artifacts into the shape we store on the
   * `post_drafts` row (caption + media urls). Pure function; no I/O.
   */
  toPostDraft(artifacts: StepArtifacts): PostDraftOutput;
};
