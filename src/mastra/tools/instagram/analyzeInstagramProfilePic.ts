import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeInstagramProfilePic } from '../../../services/onboarding/analyzeProfilePic.js';

const profilePicAnalysisOutput = z.object({
  palette: z.array(
    z.object({
      hex: z.string(),
      role: z.enum(['primary', 'secondary', 'accent', 'background', 'text', 'other']),
      name: z.string().optional(),
    }),
  ),
  logo: z.object({
    markType: z.enum(['wordmark', 'symbol', 'combo', 'monogram', 'none']),
    description: z.string(),
    colors: z.array(z.string()),
    hasTagline: z.boolean(),
  }),
});

export const analyzeInstagramProfilePicTool = createTool({
  id: 'analyzeInstagramProfilePic',
  description:
    "Analyzes an Instagram brand's *profile picture* (avatar) and returns the dominant color palette + a structured description of the logo (markType, description, colors, hasTagline). Call this after fetchInstagramProfile, passing profile.profilePicUrlHD (or profilePicUrl as fallback). The post-grid visuals analyzer covers everything else.",
  inputSchema: z.object({
    handle: z.string(),
    profilePicUrl: z
      .string()
      .url()
      .describe('Profile picture URL — prefer profilePicUrlHD when available.'),
    brandHint: z.string().optional().describe('Optional extra context from the user.'),
  }),
  outputSchema: profilePicAnalysisOutput,
  execute: async (inputData) => {
    return analyzeInstagramProfilePic({
      handle: inputData.handle,
      profilePicUrl: inputData.profilePicUrl,
      ...(inputData.brandHint ? { brandHint: inputData.brandHint } : {}),
    });
  },
});
