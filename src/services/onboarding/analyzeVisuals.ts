import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Visual analysis of an Instagram brand. We feed up to 9 post image URLs in a
 * single multi-image vision call and ask Claude Sonnet to extract a brand kit
 * (color palette, typography mood) plus a design system summary.
 */

const MAX_IMAGES = 9;

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

const visualAnalysisSchema = z.object({
  palette: z
    .array(paletteEntrySchema)
    .min(3)
    .max(7)
    .describe('3 to 7 dominant colors that define the brand on Instagram.'),
  typographyMood: z
    .string()
    .min(10)
    .max(200)
    .describe('Short description of the typographic feel (serif/sans, weight, tone).'),
  photoStyle: z.string().min(10).max(300),
  illustrationStyle: z.string().min(0).max(300),
  composition: z.string().min(10).max(300),
  lighting: z.string().min(10).max(300),
  recurringMotifs: z.array(z.string().min(2).max(60)).min(0).max(8),
  doVisuals: z.array(z.string().min(2).max(120)).min(2).max(8),
  dontVisuals: z.array(z.string().min(2).max(120)).min(2).max(8),
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
