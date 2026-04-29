import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeInstagramVisuals } from '../../../services/onboarding/analyzeVisuals.js';

const visualAnalysisOutput = z.object({
  typographyMood: z.string(),
  photoStyle: z.string(),
  illustrationStyle: z.string(),
  composition: z.string(),
  lighting: z.string(),
  recurringMotifs: z.array(z.string()),
  doVisuals: z.array(z.string()),
  dontVisuals: z.array(z.string()),
});

export const analyzeInstagramVisualsTool = createTool({
  id: 'analyzeInstagramVisuals',
  description:
    "Analyzes an Instagram brand's *post grid* visuals from the recent post images and returns a structured design system (typography mood, illustration style, photo style, composition, lighting, recurring motifs, visual do/don't). Color palette + logo come from analyzeInstagramProfilePic, not this tool. Call this after fetchInstagramProfile, passing the post imageUrls in feed order.",
  inputSchema: z.object({
    handle: z.string(),
    imageUrls: z
      .array(z.string().url())
      .min(1)
      .max(20)
      .describe('Image URLs from recent posts (typically 12). Up to 24 are accepted.'),
    brandHint: z.string().optional().describe('Optional extra context from the user.'),
  }),
  outputSchema: visualAnalysisOutput,
  execute: async (inputData) => {
    return analyzeInstagramVisuals({
      handle: inputData.handle,
      imageUrls: inputData.imageUrls,
      ...(inputData.brandHint ? { brandHint: inputData.brandHint } : {}),
    });
  },
});
