import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findBrandById } from '../../db/repositories/brands.js';

export const getBrandProfileTool = createTool({
  id: 'getBrandProfile',
  description:
    "Returns the current brand profile (handle, voice, cadence, timezone, status). Call this first whenever you need brand context before responding or generating a post.",
  inputSchema: z.object({
    brandId: z.string().describe('UUID of the brand. Pass through from request context.'),
  }),
  outputSchema: z.object({
    id: z.string(),
    waPhone: z.string(),
    igHandle: z.string().nullable(),
    voice: z.unknown().nullable(),
    cadence: z.unknown().nullable(),
    timezone: z.string(),
    status: z.string(),
  }),
  execute: async (inputData) => {
    const { brandId } = inputData;
    const brand = await findBrandById(brandId);
    if (!brand) throw new Error(`Brand ${brandId} not found`);
    return {
      id: brand.id,
      waPhone: brand.waPhone,
      igHandle: brand.igHandle,
      voice: brand.voiceJson,
      cadence: brand.cadenceJson,
      timezone: brand.timezone,
      status: brand.status,
    };
  },
});
