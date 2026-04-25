import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Text-only analysis of an Instagram brand's captions to derive a voice guide
 * (tone, audience, do/don't, themes, hashtag policy).
 */

// NOTE: Anthropic's structured-output mode rejects `minItems`/`maxItems` > 1,
// so all length/count constraints live in descriptions + the prompt rather
// than in the JSON schema.
const voiceAnalysisSchema = z.object({
  summary: z
    .string()
    .describe('One-paragraph description of how the brand actually talks (20–400 chars).'),
  tone: z
    .array(z.string())
    .describe('2 to 6 adjectives like "warm", "irreverent", "clinical" (2–40 chars each).'),
  audience: z.string().describe('Who this brand talks to (10–200 chars).'),
  do: z.array(z.string()).describe('2 to 8 short do-this voice guidelines (3–160 chars each).'),
  dont: z
    .array(z.string())
    .describe('2 to 8 short avoid-this voice guidelines (3–160 chars each).'),
  themes: z
    .array(z.string())
    .describe('Up to 8 recurring topics this brand posts about (2–60 chars each); empty if none.'),
  emojiUsage: z.enum(['none', 'sparing', 'frequent']),
  hashtagPolicy: z
    .string()
    .describe(
      'How the brand uses hashtags — count per post, branded vs generic, in-line vs bottom block (5–200 chars).',
    ),
  hashtags: z
    .array(z.string().regex(/^#?[A-Za-z0-9_]{2,40}$/u))
    .describe('Up to 15 concrete hashtags actually used or recommended for this brand.')
    .transform((arr) => arr.map((h) => (h.startsWith('#') ? h : `#${h}`))),
});

export type VoiceAnalysis = z.infer<typeof voiceAnalysisSchema>;

export type AnalyzeVoiceInput = {
  handle: string;
  biography?: string;
  captions: string[];
  brandHint?: string;
};

const SYSTEM_PROMPT = `
You are a brand voice strategist analyzing an Instagram account.
Read every caption carefully. Identify the actual voice — be specific, never generic.
Avoid corporate buzzwords. Surface the patterns that make this brand recognizable in a feed.
`.trim();

export async function analyzeInstagramVoice(input: AnalyzeVoiceInput): Promise<VoiceAnalysis> {
  const env = loadEnv();
  const log = logger.child({ analyzer: 'voice', handle: input.handle });

  // Use every non-empty caption from the IG grid (typically 12). 24 is a
  // defensive guard against accidental blow-ups, not the expected size.
  const captions = input.captions.filter((c) => c && c.trim().length > 0).slice(0, 24);
  if (captions.length === 0) {
    throw new Error('analyzeInstagramVoice: no captions provided');
  }

  const modelId = stripGatewayPrefix(env.ONBOARDING_AGENT_MODEL);
  log.info({ modelId, captionCount: captions.length }, 'Running voice analysis');

  const prompt = [
    `Brand handle: @${input.handle}`,
    input.biography ? `Bio: ${input.biography}` : '',
    input.brandHint ? `Owner-provided context: ${input.brandHint}` : '',
    '',
    'Recent captions (each separated by ---):',
    captions.map((c, i) => `--- caption ${i + 1} ---\n${c.slice(0, 1500)}`).join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n');

  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: voiceAnalysisSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  return object;
}

function stripGatewayPrefix(modelId: string): string {
  const idx = modelId.indexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}
