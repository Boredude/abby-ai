import type { Agent } from '@mastra/core/agent';
import type { z } from 'zod';
import { logger } from '../../config/logger.js';
import { requireBrandContext, type BrandContext } from '../../context/BrandContext.js';
import { setStepArtifact } from '../../db/repositories/draftGenerations.js';
import { getCopywriterAgent } from '../../mastra/agents/copywriter.js';
import { getHashtaggerAgent } from '../../mastra/agents/hashtagger.js';
import { getIdeatorAgent } from '../../mastra/agents/ideator.js';
import { getStylistAgent } from '../../mastra/agents/stylist.js';
import { generateAndStoreImage } from '../media/generateImage.js';
import {
  ART_DIRECTION_STEP,
  COPY_STEP,
  HASHTAGS_STEP,
  IDEATION_STEP,
  IMAGE_STEP,
  artDirectionArtifactSchema,
  copyArtifactSchema,
  hashtagArtifactSchema,
  ideationArtifactSchema,
  imageArtifactSchema,
  type StepArtifactInput,
  type StepArtifacts,
  type StepId,
} from './types.js';

/**
 * Run a SINGLE step of the creative pipeline for a draft.
 *
 * For text/structured steps (ideation, copy, hashtags, artDirection) we
 * invoke the matching specialist agent with `output: <stepArtifactSchema>`,
 * which forces Mastra/the AI SDK to coerce the model's response into a
 * validated JSON object. We then persist that object via `setStepArtifact`.
 * The agents never call a save tool — they can't forget to.
 *
 * For the image step there's no model decision to make: the stylist's
 * `imagePrompt` is the truth. We call `generateAndStoreImage` directly,
 * skipping an LLM hop, and persist the resulting URL.
 *
 * Failure modes are loud: a missing dependency, a refusal to produce
 * structured output, or an image-render error all throw so the caller
 * (`runCreativePipeline`) can surface a clean error to the user instead of
 * shipping a half-finished post.
 */

export type RunCreativeStepInput = {
  draftId: string;
  brandId: string;
  stepId: StepId;
  briefingHint?: string;
  /** Already-completed step artifacts. The runner reads dependency artifacts from here. */
  artifacts: StepArtifacts;
};

export type RunCreativeStepResult = {
  stepId: StepId;
  artifact: StepArtifactInput['artifact'];
};

export async function runCreativeStep(
  input: RunCreativeStepInput,
): Promise<RunCreativeStepResult> {
  const { draftId, brandId, stepId, briefingHint, artifacts } = input;

  const log = logger.child({ draftId, brandId, stepId });
  log.info({ briefingHint: briefingHint ?? null }, 'runCreativeStep: start');

  // Each branch builds its own discriminated-union arm so the call to
  // `setStepArtifact` is fully typed without an `as` cast.
  let typed: StepArtifactInput;
  switch (stepId) {
    case IDEATION_STEP:
      typed = { step: IDEATION_STEP, artifact: await runIdeation({ brandId, briefingHint, artifacts }) };
      break;
    case COPY_STEP:
      typed = { step: COPY_STEP, artifact: await runCopy({ brandId, briefingHint, artifacts }) };
      break;
    case HASHTAGS_STEP:
      typed = { step: HASHTAGS_STEP, artifact: await runHashtags({ brandId, briefingHint, artifacts }) };
      break;
    case ART_DIRECTION_STEP:
      typed = { step: ART_DIRECTION_STEP, artifact: await runArtDirection({ brandId, briefingHint, artifacts }) };
      break;
    case IMAGE_STEP:
      typed = { step: IMAGE_STEP, artifact: await runImage({ brandId, artifacts }) };
      break;
    default: {
      const _exhaustive: never = stepId;
      throw new Error(`runCreativeStep: unknown stepId '${_exhaustive}'`);
    }
  }

  await setStepArtifact(draftId, typed);
  log.info('runCreativeStep: artifact persisted');

  return { stepId, artifact: typed.artifact };
}

// ---------- per-step runners ----------

type AgentStepArgs = {
  brandId: string;
  briefingHint?: string;
  artifacts: StepArtifacts;
};

async function runIdeation(args: AgentStepArgs) {
  const ctx = await requireBrandContext(args.brandId);
  const prompt = buildPrompt({
    title: 'Pick a fresh, on-brand ideation for ONE Instagram post',
    sections: [
      brandSection(ctx),
      args.briefingHint
        ? { label: 'Briefing hint (use as starting point)', body: args.briefingHint }
        : null,
      {
        label: 'Output requirements',
        body: 'Return JSON matching the provided schema. Be specific — "talk about our menu" is not an angle, "a top-down pour shot of the new matcha spritz at golden hour" is.',
      },
    ],
  });
  return runStructuredAgent(getIdeatorAgent(), prompt, ideationArtifactSchema);
}

async function runCopy(args: AgentStepArgs) {
  const ideation = requireDependency(args.artifacts, IDEATION_STEP);
  const ctx = await requireBrandContext(args.brandId);
  const prompt = buildPrompt({
    title: "Write the caption in the brand's voice",
    sections: [
      brandSection(ctx),
      { label: 'Ideation', body: JSON.stringify(ideation, null, 2) },
      args.briefingHint ? { label: 'Edit note', body: args.briefingHint } : null,
      {
        label: 'Output requirements',
        body:
          'Return JSON matching the provided schema. Do NOT include hashtags in `fullCaption` (the hashtagger handles them). ' +
          'No emojis unless the voice opts in (`emojiUsage !== "none"`). ' +
          'Keep it Instagram-native: first line must hook the reader.',
      },
    ],
  });
  return runStructuredAgent(getCopywriterAgent(), prompt, copyArtifactSchema);
}

async function runHashtags(args: AgentStepArgs) {
  const copy = requireDependency(args.artifacts, COPY_STEP);
  const ctx = await requireBrandContext(args.brandId);
  const prompt = buildPrompt({
    title: 'Pick an on-brand hashtag set for the caption below',
    sections: [
      brandSection(ctx),
      { label: 'Caption', body: copy.fullCaption },
      args.briefingHint ? { label: 'Edit note', body: args.briefingHint } : null,
      {
        label: 'Output requirements',
        body:
          'Return JSON matching the provided schema. ' +
          'Respect the brand voice `hashtagPolicy` if set. Default 3–8 niche tags; ' +
          '0 tags if the voice opts out. Prefer brand-native tags from `voice.hashtags` first.',
      },
    ],
  });
  return runStructuredAgent(getHashtaggerAgent(), prompt, hashtagArtifactSchema);
}

async function runArtDirection(args: AgentStepArgs) {
  const ideation = requireDependency(args.artifacts, IDEATION_STEP);
  const ctx = await requireBrandContext(args.brandId);
  const prompt = buildPrompt({
    title: 'Produce an art direction + image prompt for ONE image',
    sections: [
      brandSection(ctx),
      { label: 'Ideation', body: JSON.stringify(ideation, null, 2) },
      args.briefingHint ? { label: 'Edit note', body: args.briefingHint } : null,
      {
        label: 'Output requirements',
        body:
          'Return JSON matching the provided schema. ' +
          'Echo palette hexes from the brand kit (no fabricated colors). ' +
          '`imagePrompt` must be 30–80 words: subject + composition + lighting + palette + mood. ' +
          'Do not place text on the image. Default `size` to "1024x1536" (portrait IG feed) ' +
          'unless the design system clearly calls for square or landscape.',
      },
    ],
  });
  return runStructuredAgent(getStylistAgent(), prompt, artDirectionArtifactSchema);
}

async function runImage(args: { brandId: string; artifacts: StepArtifacts }) {
  const direction = requireDependency(args.artifacts, ART_DIRECTION_STEP);
  // Resolve the brand's IG handle so the R2 key uses the legible
  // `images/<handle>/...` folder. Best-effort: the storage layer falls back
  // to the brand id if no slug is available.
  const ctx = await requireBrandContext(args.brandId);
  const ownerSlug = ctx.brand.igHandle ?? undefined;
  const result = await generateAndStoreImage({
    prompt: direction.imagePrompt,
    size: direction.size,
    ownerId: args.brandId,
    ...(ownerSlug ? { ownerSlug } : {}),
    kind: 'draft',
  });
  return imageArtifactSchema.parse(result);
}

// ---------- helpers ----------

/**
 * Invoke a Mastra agent with a forced structured output. Mastra wraps the
 * AI SDK's `generateObject` and guarantees `result.object` matches the
 * schema (or throws). We re-parse defensively so the caller sees a clean
 * Zod error if the SDK contract ever drifts.
 *
 * No memory is attached: the user never sees these turns, and we don't want
 * the agent's intermediate output leaking into the brand's shared thread.
 */
async function runStructuredAgent<S extends z.ZodTypeAny>(
  agent: Agent,
  prompt: string,
  schema: S,
): Promise<z.output<S>> {
  const result = await agent.generate(prompt, {
    structuredOutput: { schema },
  });
  const obj = (result as { object?: unknown }).object;
  if (obj === undefined) {
    throw new Error(
      `Agent ${agent.id} returned no structured output. Got text: ${(result as { text?: string }).text?.slice(0, 200) ?? '<no text>'}`,
    );
  }
  return schema.parse(obj);
}

function requireDependency<K extends keyof StepArtifacts>(
  artifacts: StepArtifacts,
  step: K,
): NonNullable<StepArtifacts[K]> {
  const v = artifacts[step];
  if (!v) {
    throw new Error(`runCreativeStep: dependency '${String(step)}' not found in completed artifacts`);
  }
  return v as NonNullable<StepArtifacts[K]>;
}

type PromptSection = { label: string; body: string };

function buildPrompt(args: {
  title: string;
  sections: ReadonlyArray<PromptSection | null>;
}): string {
  const parts: string[] = [args.title];
  for (const s of args.sections) {
    if (!s) continue;
    parts.push(`\n---\n${s.label}:\n${s.body}`);
  }
  return parts.join('\n');
}

function brandSection(ctx: BrandContext): PromptSection {
  const summary: Record<string, unknown> = {
    handle: ctx.brand.igHandle ?? null,
    timezone: ctx.brand.timezone,
  };
  if (ctx.brand.voiceJson) summary.voice = ctx.brand.voiceJson;
  if (ctx.brand.brandKitJson) summary.brandKit = ctx.brand.brandKitJson;
  if (ctx.brand.designSystemJson) summary.designSystem = ctx.brand.designSystemJson;
  return {
    label: 'Brand context',
    body: JSON.stringify(summary, null, 2),
  };
}
