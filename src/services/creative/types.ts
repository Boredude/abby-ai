import { z } from 'zod';

/**
 * Per-step artifact schemas for the creative pipeline.
 *
 * Each specialist sub-agent commits its output by calling the
 * `saveStepArtifact` tool with a payload that matches one of these schemas.
 * Keeping them narrow, strict, and discriminated by `step` is what lets the
 * director orchestrate deterministically — the agents produce data, not prose.
 *
 * Adding a new step:
 *   1. Define its artifact schema here (include it in `stepArtifactSchema`).
 *   2. Reference the step in a `ContentType.pipeline` entry.
 *   3. Wire a specialist sub-agent that emits it.
 */

export const IDEATION_STEP = 'ideation' as const;
export const COPY_STEP = 'copy' as const;
export const HASHTAGS_STEP = 'hashtags' as const;
export const ART_DIRECTION_STEP = 'artDirection' as const;
export const IMAGE_STEP = 'image' as const;

export const stepIdSchema = z.enum([
  IDEATION_STEP,
  COPY_STEP,
  HASHTAGS_STEP,
  ART_DIRECTION_STEP,
  IMAGE_STEP,
]);
export type StepId = z.infer<typeof stepIdSchema>;

// ---------- per-step artifact schemas ----------

export const ideationArtifactSchema = z.object({
  topic: z.string().min(3).describe("One-line topic of the post (e.g. 'New summer menu launch')."),
  angle: z.string().min(10).describe('The specific creative angle / hook the post takes on the topic.'),
  themes: z.array(z.string()).default([]).describe('Brand themes this post draws on.'),
  rationale: z.string().max(400).describe("Brief explanation of why this idea is on-brand and fresh."),
});
export type IdeationArtifact = z.infer<typeof ideationArtifactSchema>;

export const copyArtifactSchema = z.object({
  hook: z.string().min(1).describe('First line of the caption — stops the scroll.'),
  body: z.string().min(1).describe('Body of the caption (2–4 short paragraphs, in brand voice).'),
  cta: z.string().min(1).describe('Closing call-to-action.'),
  fullCaption: z
    .string()
    .min(40)
    .describe("The assembled caption text (hook + body + cta). No hashtags, no emojis unless the voice opts in."),
});
export type CopyArtifact = z.infer<typeof copyArtifactSchema>;

export const hashtagArtifactSchema = z.object({
  hashtags: z
    .array(z.string().regex(/^#?[\p{L}\p{N}_]+$/u))
    .min(0)
    .max(15)
    .describe("Hashtag tokens with or without the leading '#'. Respect the brand's hashtag policy."),
  rationale: z.string().max(280).optional(),
});
export type HashtagArtifact = z.infer<typeof hashtagArtifactSchema>;

export const artDirectionArtifactSchema = z.object({
  subject: z.string().min(3).describe('What is the image actually of?'),
  composition: z.string().min(3).describe('Framing, focal point, layout.'),
  lighting: z.string().min(3),
  palette: z.array(z.string()).describe('Hex or named colors the image should lean into.'),
  mood: z.string().min(3),
  imagePrompt: z
    .string()
    .min(30)
    .describe('The vivid, on-brand image-generator prompt (subject + composition + lighting + palette + mood).'),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1536'),
});
export type ArtDirectionArtifact = z.infer<typeof artDirectionArtifactSchema>;

export const imageArtifactSchema = z.object({
  url: z.string().url(),
  key: z.string(),
  prompt: z.string().min(1).describe("Echo of the prompt actually sent to the image model (post-sanitization)."),
});
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;

// ---------- discriminated union for the saveStepArtifact tool ----------

export const stepArtifactInputSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal(IDEATION_STEP), artifact: ideationArtifactSchema }),
  z.object({ step: z.literal(COPY_STEP), artifact: copyArtifactSchema }),
  z.object({ step: z.literal(HASHTAGS_STEP), artifact: hashtagArtifactSchema }),
  z.object({ step: z.literal(ART_DIRECTION_STEP), artifact: artDirectionArtifactSchema }),
  z.object({ step: z.literal(IMAGE_STEP), artifact: imageArtifactSchema }),
]);
export type StepArtifactInput = z.infer<typeof stepArtifactInputSchema>;

// ---------- generation blob persisted on post_drafts.generation ----------

export const postDraftGenerationSchema = z.object({
  contentTypeId: z.string(),
  steps: z
    .object({
      [IDEATION_STEP]: ideationArtifactSchema.optional(),
      [COPY_STEP]: copyArtifactSchema.optional(),
      [HASHTAGS_STEP]: hashtagArtifactSchema.optional(),
      [ART_DIRECTION_STEP]: artDirectionArtifactSchema.optional(),
      [IMAGE_STEP]: imageArtifactSchema.optional(),
    })
    .default({}),
  editHistory: z
    .array(
      z.object({
        at: z.string(),
        note: z.string(),
        invalidated: z.array(stepIdSchema),
      }),
    )
    .default([]),
});
export type PostDraftGeneration = z.infer<typeof postDraftGenerationSchema>;

// ---------- brief + directives ----------

export const creativeBriefSchema = z.object({
  brandId: z.string(),
  contentTypeId: z.string(),
  /** Optional user-provided hint ("make a post about our summer menu"). */
  briefingHint: z.string().optional(),
});
export type CreativeBrief = z.infer<typeof creativeBriefSchema>;

export const editDirectiveSchema = z.object({
  note: z.string(),
  invalidate: z.array(stepIdSchema).default([]),
});
export type EditDirective = z.infer<typeof editDirectiveSchema>;

// ---------- artifact dictionary (typed by step id) ----------

export type StepArtifacts = PostDraftGeneration['steps'];
