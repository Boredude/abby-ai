import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { findBrandById } from '../../db/repositories/brands.js';
import { generateAndStoreImage } from '../../services/media/generateImage.js';

export const generateImageTool = createTool({
  id: 'generateImage',
  description:
    'Generates an Instagram-ready image using OpenAI ChatGPT Images 2 (gpt-image-2) and uploads it to public storage. Returns a public URL that can be sent on WhatsApp or used as the post media. Use a vivid, specific prompt — describe subject, composition, lighting, and brand vibe.',
  inputSchema: z.object({
    prompt: z.string().min(10).describe('Image prompt. Be specific about subject, composition, lighting, mood.'),
    size: z
      .enum(['1024x1024', '1024x1536', '1536x1024'])
      .optional()
      .describe('1024x1024 square (default), 1024x1536 portrait (best for IG feed), or 1536x1024 landscape.'),
    quality: z.enum(['low', 'medium', 'high']).optional(),
    brandId: z.string().optional().describe('Brand id used to namespace the storage key.'),
  }),
  outputSchema: z.object({
    url: z.string().url(),
    key: z.string(),
    prompt: z.string(),
  }),
  execute: async (inputData) => {
    // Resolve the brand's IG handle so the R2 key uses the legible
    // `images/<handle>/...` folder instead of `images/<uuid>/...`. Best-effort:
    // if the lookup fails (race during early onboarding, transient db hiccup)
    // we still ship the image, just under the brand-id fallback folder.
    let ownerSlug: string | undefined;
    if (inputData.brandId) {
      try {
        const brand = await findBrandById(inputData.brandId);
        if (brand?.igHandle) ownerSlug = brand.igHandle;
      } catch (err) {
        logger.warn({ err, brandId: inputData.brandId }, 'generateImage: brand lookup failed; using id fallback');
      }
    }

    return generateAndStoreImage({
      prompt: inputData.prompt,
      ...(inputData.size ? { size: inputData.size } : {}),
      ...(inputData.quality ? { quality: inputData.quality } : {}),
      ...(inputData.brandId ? { ownerId: inputData.brandId } : {}),
      ...(ownerSlug ? { ownerSlug } : {}),
    });
  },
});
