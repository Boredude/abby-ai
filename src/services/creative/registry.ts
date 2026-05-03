import type { StepId } from './types.js';
import type { ContentType, PipelineStep } from './contentTypes/types.js';
import { igSinglePostContentType } from './contentTypes/igSinglePost.js';

/**
 * ContentType registry. Adding a new content type (carousel, reel, …) is a
 * new file under `contentTypes/` + one entry here. The director and the
 * approval workflow don't change.
 */

export const CONTENT_TYPES: Record<string, ContentType> = {
  [igSinglePostContentType.id]: igSinglePostContentType,
};

export type ContentTypeId = keyof typeof CONTENT_TYPES & string;

export function getContentType(id: string): ContentType {
  const ct = CONTENT_TYPES[id];
  if (!ct) throw new Error(`Unknown contentType '${id}'. Known: ${Object.keys(CONTENT_TYPES).join(', ')}`);
  return ct;
}

export function listContentTypes(): ContentType[] {
  return Object.values(CONTENT_TYPES);
}

/**
 * Expand an "invalidated steps" list to include every downstream dependent
 * in the content type's DAG. This is the actual invariant the edit loop
 * needs: if the user says "new caption", we must also drop the hashtags
 * (which were tuned to the old caption) — not just the caption itself.
 */
export function expandInvalidatedSteps(
  contentType: ContentType,
  seed: readonly StepId[],
): StepId[] {
  const byId = new Map<StepId, PipelineStep>();
  for (const step of contentType.pipeline) byId.set(step.id, step);

  const out = new Set<StepId>(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of contentType.pipeline) {
      if (out.has(step.id)) continue;
      if (step.dependsOn.some((d) => out.has(d))) {
        out.add(step.id);
        grew = true;
      }
    }
  }
  return contentType.pipeline.filter((s) => out.has(s.id)).map((s) => s.id);
}
