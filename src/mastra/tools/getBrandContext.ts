import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { loadBrandContext } from '../../context/BrandContext.js';

/**
 * Returns a unified read-only snapshot of a brand: profile fields + voice +
 * cadence + brand kit summary + connected channels. Replaces the older
 * `getBrandProfile` tool and is the canonical "what do we know about this
 * brand" source for Duffy and sub-agents.
 */
export const getBrandContextTool = createTool({
  id: 'getBrandContext',
  description:
    "Returns the brand's full context: profile (handle, voice, cadence, timezone, status), brand kit summary, design system summary, and connected channels. Call this BEFORE replying to any non-trivial message so you have current state.",
  inputSchema: z.object({
    brandId: z.string().describe('UUID of the brand. Pass through from your conversation context.'),
  }),
  outputSchema: z.object({
    id: z.string(),
    igHandle: z.string().nullable(),
    voice: z.unknown().nullable(),
    cadence: z.unknown().nullable(),
    brandKit: z.unknown().nullable(),
    designSystem: z.unknown().nullable(),
    timezone: z.string(),
    status: z.string(),
    channels: z.array(
      z.object({
        kind: z.string(),
        externalId: z.string(),
        isPrimary: z.boolean(),
        status: z.string(),
      }),
    ),
    primaryChannelKind: z.string().nullable(),
  }),
  execute: async ({ brandId }) => {
    const ctx = await loadBrandContext(brandId);
    if (!ctx) throw new Error(`Brand ${brandId} not found`);
    return {
      id: ctx.brand.id,
      igHandle: ctx.brand.igHandle,
      voice: ctx.brand.voiceJson,
      cadence: ctx.brand.cadenceJson,
      brandKit: ctx.brand.brandKitJson,
      designSystem: ctx.brand.designSystemJson,
      timezone: ctx.brand.timezone,
      status: ctx.brand.status,
      channels: ctx.channels.map((c) => ({
        kind: c.kind,
        externalId: c.externalId,
        isPrimary: c.isPrimary,
        status: c.status,
      })),
      primaryChannelKind: ctx.primaryChannel?.kind ?? null,
    };
  },
});
