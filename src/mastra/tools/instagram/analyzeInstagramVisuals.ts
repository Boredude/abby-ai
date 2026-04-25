import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeInstagramVisuals } from '../../../services/onboarding/analyzeVisuals.js';

const visualAnalysisOutput = z.object({
  palette: z.array(
    z.object({
      hex: z.string(),
      role: z.enum(['primary', 'secondary', 'accent', 'background', 'text', 'other']),
      name: z.string().optional(),
    }),
  ),
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
    "Analyzes an Instagram brand's visuals from up to 9 post images and returns a structured brand kit + design system (palette, typography mood, photo/illustration style, composition, lighting, recurring motifs, visual do/don't). Call this after fetchInstagramProfile, passing the post imageUrls in feed order.",
  inputSchema: z.object({
    handle: z.string(),
    imageUrls: z
      .array(z.string().url())
      .min(1)
      .max(20)
      .describe('Image URLs from recent posts. Up to the first 9 will be analyzed.'),
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
