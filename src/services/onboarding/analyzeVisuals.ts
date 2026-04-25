import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Visual analysis of an Instagram brand. We feed every post image we have for
 * the IG grid (typically 12 — Apify's `details` mode returns the most recent
 * 12 posts) into a single multi-image vision call and ask Claude Sonnet to
 * extract a brand kit (color palette, typography mood) plus a design system
 * summary.
 *
 * The hard cap exists only as a defensive guard against accidental input
 * blow-ups; in practice the scraper returns ~12.
 */

const MAX_IMAGES = 24;

const paletteEntrySchema = z.object({
  hex: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/u)
    .describe('A 6-digit hex color sampled from the brand visuals.')
    .transform((v) => (v.startsWith('#') ? v.toLowerCase() : `#${v.toLowerCase()}`)),
  role: z
    .enum(['primary', 'secondary', 'accent', 'background', 'text', 'other'])
    .describe('Functional role of this color in the brand.'),
  name: z
    .string()
    .max(40)
    .optional()
    .describe('Optional human-friendly name (e.g. "warm sand", "deep navy").'),
});

// NOTE: Anthropic's structured-output mode rejects `minItems`/`maxItems` > 1,
// so we keep array sizes free in the schema and steer counts via descriptions
// + the prompt instead.
const visualAnalysisSchema = z.object({
  palette: z
    .array(paletteEntrySchema)
    .describe('3 to 7 dominant colors that define the brand on Instagram.'),
  typographyMood: z
    .string()
    .describe('Short description of the typographic feel (serif/sans, weight, tone), 10–200 chars.'),
  photoStyle: z.string().describe('Photo style description, 10–300 chars.'),
  illustrationStyle: z
    .string()
    .describe('Illustration/graphic style description; empty string if none, otherwise up to 300 chars.'),
  composition: z.string().describe('Composition style description, 10–300 chars.'),
  lighting: z.string().describe('Lighting style description, 10–300 chars.'),
  recurringMotifs: z
    .array(z.string())
    .describe('Up to 8 recurring motifs/objects/themes (2–60 chars each); empty if none.'),
  doVisuals: z
    .array(z.string())
    .describe('2 to 8 short do-this guidelines for visuals (2–120 chars each).'),
  dontVisuals: z
    .array(z.string())
    .describe("2 to 8 short avoid-this guidelines for visuals (2–120 chars each)."),
});

export type VisualAnalysis = z.infer<typeof visualAnalysisSchema>;

export type AnalyzeVisualsInput = {
  handle: string;
  imageUrls: string[];
  brandHint?: string;
};

const SYSTEM_PROMPT = `
You are a senior brand designer auditing an Instagram feed.
Look at every image carefully and synthesize a coherent visual brand identity.
Be specific and actionable — this output will be used to generate future on-brand visuals.
Use concrete adjectives, not corporate fluff. Never invent colors or motifs that aren't actually in the images.
`.trim();

export async function analyzeInstagramVisuals(input: AnalyzeVisualsInput): Promise<VisualAnalysis> {
  const env = loadEnv();
  const log = logger.child({ analyzer: 'visuals', handle: input.handle });

  const urls = input.imageUrls.slice(0, MAX_IMAGES);
  if (urls.length === 0) {
    throw new Error('analyzeInstagramVisuals: no image URLs provided');
  }

  const modelId = stripGatewayPrefix(env.ONBOARDING_AGENT_MODEL);
  log.info({ modelId, imageCount: urls.length }, 'Running visual analysis');

  const userText = [
    `Brand handle: @${input.handle}`,
    input.brandHint ? `Owner-provided context: ${input.brandHint}` : '',
    `I'm sending you ${urls.length} recent Instagram posts in order.`,
    'Extract the brand kit + design system that ties them together.',
  ]
    .filter(Boolean)
    .join('\n');

  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: visualAnalysisSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...urls.map((url) => ({ type: 'image' as const, image: new URL(url) })),
        ],
      },
    ],
    system: SYSTEM_PROMPT,
  });

  return object;
}

/**
 * Mastra model ids look like "anthropic/claude-sonnet-4-5"; the AI SDK's
 * `anthropic(...)` factory just wants the bare model id.
 */
function stripGatewayPrefix(modelId: string): string {
  const idx = modelId.indexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}
