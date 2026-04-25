import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeInstagramVoice } from '../../../services/onboarding/analyzeVoice.js';

const voiceAnalysisOutput = z.object({
  summary: z.string(),
  tone: z.array(z.string()),
  audience: z.string(),
  do: z.array(z.string()),
  dont: z.array(z.string()),
  themes: z.array(z.string()),
  emojiUsage: z.enum(['none', 'sparing', 'frequent']),
  hashtagPolicy: z.string(),
  hashtags: z.array(z.string()),
});

export const analyzeInstagramVoiceTool = createTool({
  id: 'analyzeInstagramVoice',
  description:
    "Analyzes the captions of an Instagram brand and returns a structured voice guide (summary, tone, audience, do/don't, themes, emoji usage, hashtag policy and concrete hashtags). Call this after fetchInstagramProfile with the recent post captions.",
  inputSchema: z.object({
    handle: z.string(),
    biography: z.string().optional(),
    captions: z
      .array(z.string())
      .min(1)
      .describe('Captions from recent posts, in feed order.'),
    brandHint: z.string().optional(),
  }),
  outputSchema: voiceAnalysisOutput,
  execute: async (inputData) => {
    return analyzeInstagramVoice({
      handle: inputData.handle,
      captions: inputData.captions,
      ...(inputData.biography ? { biography: inputData.biography } : {}),
      ...(inputData.brandHint ? { brandHint: inputData.brandHint } : {}),
    });
  },
});
