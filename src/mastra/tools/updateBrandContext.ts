import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { updateBrand } from '../../db/repositories/brands.js';

const voiceSchema = z.object({
  summary: z.string(),
  tone: z.array(z.string()),
  audience: z.string(),
  do: z.array(z.string()),
  dont: z.array(z.string()),
  hashtags: z.array(z.string()).optional(),
});

const cadenceSchema = z.object({
  postsPerWeek: z.number().int().min(1).max(21),
  preferredHourLocal: z.number().int().min(0).max(23).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
});

/**
 * Persists partial updates to a brand's profile fields. Replaces
 * `updateBrandProfile`. Pass only the fields you want to change — undefined
 * fields are left alone, explicit `null` clears them.
 *
 * NOTE: deeper structures (brand kit, design system) are owned by their
 * respective sub-agents (onboarding, stylist) and persisted via specialized
 * tools — not through this generic update.
 */
export const updateBrandContextTool = createTool({
  id: 'updateBrandContext',
  description:
    'Persists a partial brand profile update — Instagram handle, voice, cadence, timezone, or status. Use this whenever the user gives you a new fact about their brand or preferences.',
  inputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string().nullable().optional(),
    voice: voiceSchema.nullable().optional(),
    cadence: cadenceSchema.nullable().optional(),
    timezone: z.string().optional(),
    status: z.enum(['pending', 'onboarding', 'active', 'paused']).optional(),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (inputData) => {
    const patch: Parameters<typeof updateBrand>[1] = {};
    if (inputData.igHandle !== undefined) patch.igHandle = inputData.igHandle;
    if (inputData.voice !== undefined) patch.voiceJson = inputData.voice;
    if (inputData.cadence !== undefined) patch.cadenceJson = inputData.cadence;
    if (inputData.timezone !== undefined) patch.timezone = inputData.timezone;
    if (inputData.status !== undefined) patch.status = inputData.status;
    await updateBrand(inputData.brandId, patch);
    return { ok: true as const };
  },
});
