import {
  ART_DIRECTION_STEP,
  COPY_STEP,
  HASHTAGS_STEP,
  IDEATION_STEP,
  IMAGE_STEP,
  type StepArtifacts,
} from '../types.js';
import type { ContentType, PostDraftOutput } from './types.js';

/**
 * Instagram single-image feed post.
 *
 * Pipeline (top-down = execution order; `dependsOn` encodes the actual DAG
 * the director walks when deciding what to rerun after an edit):
 *
 *   ideation  ← brand context
 *   copy      ← ideation
 *   hashtags  ← copy
 *   artDirection ← ideation
 *   image     ← artDirection
 *
 * Invalidating `copy` rips out `hashtags`; invalidating `artDirection`
 * rips out `image`; invalidating `ideation` rips out everything.
 */

function ensureCaption(artifacts: StepArtifacts): string {
  const copy = artifacts.copy;
  const hashtags = artifacts.hashtags;
  if (!copy) throw new Error("igSinglePost.toPostDraft: missing 'copy' artifact");

  const body = copy.fullCaption.trim();
  const tags = (hashtags?.hashtags ?? [])
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .join(' ')
    .trim();

  return tags ? `${body}\n\n${tags}` : body;
}

function ensureMediaUrls(artifacts: StepArtifacts): string[] {
  const image = artifacts.image;
  if (!image) throw new Error("igSinglePost.toPostDraft: missing 'image' artifact");
  return [image.url];
}

export const igSinglePostContentType: ContentType = {
  id: 'igSinglePost',
  displayName: 'Instagram single-image post',
  description:
    "Classic single-image IG feed post: on-brand idea, caption in the brand voice, hashtag set, portrait image rendered from an art-directed prompt.",
  pipeline: [
    {
      id: IDEATION_STEP,
      agentName: 'ideatorAgent',
      dependsOn: [],
      description: 'Pick a fresh, on-brand topic + angle for this post.',
    },
    {
      id: COPY_STEP,
      agentName: 'copywriterAgent',
      dependsOn: [IDEATION_STEP],
      description: 'Write the caption (hook + body + CTA) in the brand voice.',
    },
    {
      id: HASHTAGS_STEP,
      agentName: 'hashtaggerAgent',
      dependsOn: [COPY_STEP],
      description: "Produce a hashtag set that matches the voice's hashtag policy.",
    },
    {
      id: ART_DIRECTION_STEP,
      agentName: 'stylistAgent',
      dependsOn: [IDEATION_STEP],
      description: 'Translate the idea into concrete art direction + an image prompt.',
    },
    {
      id: IMAGE_STEP,
      // Deterministic step: runCreativeStep forwards the stylist's
      // `imagePrompt` straight to the image model. No LLM in the loop.
      agentName: null,
      dependsOn: [ART_DIRECTION_STEP],
      description: 'Render the image from the art direction prompt and store it in R2.',
    },
  ],
  toPostDraft(artifacts: StepArtifacts): PostDraftOutput {
    return {
      caption: ensureCaption(artifacts),
      mediaUrls: ensureMediaUrls(artifacts),
    };
  },
};
