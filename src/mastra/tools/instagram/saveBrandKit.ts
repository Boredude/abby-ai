import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { updateBrand } from '../../../db/repositories/brands.js';
import { synthesizeBrandKit } from '../../../services/onboarding/synthesizeBrandKit.js';

const profileInputSchema = z.object({
  username: z.string(),
  url: z.string(),
  fullName: z.string().optional(),
  biography: z.string().optional(),
  followersCount: z.number().optional(),
  followsCount: z.number().optional(),
  postsCount: z.number().optional(),
  profilePicUrl: z.string().optional(),
  profilePicUrlHD: z.string().optional(),
  isVerified: z.boolean().optional(),
  isBusinessAccount: z.boolean().optional(),
  externalUrl: z.string().optional(),
});

const postInputSchema = z.object({
  id: z.string(),
  type: z.string(),
  shortCode: z.string(),
  url: z.string(),
  caption: z.string(),
  imageUrl: z.string(),
  images: z.array(z.string()),
  likesCount: z.number().optional(),
  commentsCount: z.number().optional(),
  timestamp: z.string().optional(),
  isPinned: z.boolean().optional(),
  alt: z.string().optional(),
  mentions: z.array(z.string()).optional(),
});

const profilePicInputSchema = z.object({
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

const visualsInputSchema = z.object({
  typographyMood: z.string(),
  photoStyle: z.string(),
  illustrationStyle: z.string(),
  composition: z.string(),
  lighting: z.string(),
  recurringMotifs: z.array(z.string()),
  doVisuals: z.array(z.string()),
  dontVisuals: z.array(z.string()),
});

const voiceInputSchema = z.object({
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

export const saveBrandKitTool = createTool({
  id: 'saveBrandKit',
  description:
    'Synthesizes the profile-pic + visual + voice analyses with the raw Instagram scrape into a brand kit, design system, and voice guide, and persists them to the brand record. Call this once all three analyses are complete and before reporting back to the user.',
  inputSchema: z.object({
    brandId: z.string().describe('UUID of the brand to update.'),
    scrape: z.object({
      profile: profileInputSchema,
      posts: z.array(postInputSchema),
    }),
    profilePic: profilePicInputSchema,
    visuals: visualsInputSchema,
    voice: voiceInputSchema,
  }),
  outputSchema: z.object({
    ok: z.literal(true),
    brandKit: z.unknown(),
    designSystem: z.unknown(),
    voice: z.unknown(),
  }),
  execute: async (inputData) => {
    const synthesized = synthesizeBrandKit({
      scrape: inputData.scrape,
      profilePic: inputData.profilePic,
      visuals: inputData.visuals,
      voice: inputData.voice,
    });

    await updateBrand(inputData.brandId, {
      igHandle: inputData.scrape.profile.username,
      brandKitJson: synthesized.brandKit,
      designSystemJson: synthesized.designSystem,
      voiceJson: synthesized.voice,
      igAnalysisJson: synthesized.igAnalysis,
    });

    return {
      ok: true as const,
      brandKit: synthesized.brandKit,
      designSystem: synthesized.designSystem,
      voice: synthesized.voice,
    };
  },
});
