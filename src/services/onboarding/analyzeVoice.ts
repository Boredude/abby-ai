import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Text-only analysis of an Instagram brand's captions to derive a voice guide
 * (tone, audience, do/don't, themes, hashtag policy).
 */

const voiceAnalysisSchema = z.object({
  summary: z
    .string()
    .min(20)
    .max(400)
    .describe('One-paragraph description of how the brand actually talks.'),
  tone: z
    .array(z.string().min(2).max(40))
    .min(2)
    .max(6)
    .describe('Adjectives like "warm", "irreverent", "clinical".'),
  audience: z.string().min(10).max(200),
  do: z.array(z.string().min(3).max(160)).min(2).max(8),
  dont: z.array(z.string().min(3).max(160)).min(2).max(8),
  themes: z
    .array(z.string().min(2).max(60))
    .min(0)
    .max(8)
    .describe('Recurring topics this brand posts about.'),
  emojiUsage: z.enum(['none', 'sparing', 'frequent']),
  hashtagPolicy: z
    .string()
    .min(5)
    .max(200)
    .describe(
      'How the brand uses hashtags — count per post, branded vs generic, in-line vs bottom block.',
    ),
  hashtags: z
    .array(z.string().regex(/^#?[A-Za-z0-9_]{2,40}$/u))
    .min(0)
    .max(15)
    .describe('Concrete hashtags actually used or recommended for this brand.')
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

  const captions = input.captions.filter((c) => c && c.trim().length > 0).slice(0, 12);
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
