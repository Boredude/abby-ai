import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findBrandById } from '../../db/repositories/brands.js';

/**
 * Returns the brand-board image URL that was generated and persisted during
 * onboarding (and refreshed on brand-kit edits). The board is the canonical,
 * already-approved moodboard artifact for the brand — Duffy should send THIS
 * URL when the user asks to see / re-send the brand board, never re-generate
 * one with `generateImage`.
 *
 * Returns `{ url: null }` when no board has been generated yet (e.g.
 * onboarding hasn't completed). The agent should tell the user the board
 * isn't ready rather than fabricate one.
 */
export const getBrandBoardTool = createTool({
  id: 'getBrandBoard',
  description:
    "Fetch the brand's persisted brand-board (moodboard) image URL. Call this whenever the user asks to see, view, or re-send their brand board / moodboard. Pair the returned URL with `sendChannelMessage` (type=image) to deliver it. Do NOT use `generateImage` to recreate the board — the persisted URL is the canonical artifact.",
  inputSchema: z.object({
    brandId: z.string().describe('UUID of the brand. Pass through from your conversation context.'),
  }),
  outputSchema: z.object({
    url: z.string().url().nullable(),
    igHandle: z.string().nullable(),
  }),
  execute: async ({ brandId }) => {
    const brand = await findBrandById(brandId);
    if (!brand) throw new Error(`Brand ${brandId} not found`);
    return {
      url: brand.brandBoardImageUrl,
      igHandle: brand.igHandle,
    };
  },
});
