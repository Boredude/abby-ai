import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { findBrandById, updateBrand } from '../../db/repositories/brands.js';
import { sendText } from '../../services/kapso/client.js';
import { logger } from '../../config/logger.js';
import type { BrandVoice, BrandCadence } from '../../db/schema.js';

/**
 * Brand onboarding workflow.
 *
 * Plays a 4-question Q&A over WhatsApp to bootstrap a brand profile:
 *   1. Instagram handle
 *   2. Brand description (used to derive voice via the Abby agent later)
 *   3. Posting cadence (posts per week + preferred time)
 *   4. Timezone
 *
 * Each step sends a WA prompt the first time it runs and then SUSPENDS. The
 * Kapso webhook resumes the run with the user's reply via the inbound
 * dispatcher.
 */

const replySchema = z.object({ reply: z.string() });
const suspendSchema = z.object({ question: z.string() });

async function getBrandPhone(brandId: string): Promise<string> {
  const brand = await findBrandById(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);
  return brand.waPhone;
}

const askIgHandle = createStep({
  id: 'ask-ig-handle',
  inputSchema: z.object({ brandId: z.string() }),
  outputSchema: z.object({ brandId: z.string(), igHandle: z.string() }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await updateBrand(inputData.brandId, { status: 'onboarding' });
      await sendText(
        phone,
        "Hey, I'm Abby — your AI content partner. I'll help you plan and draft Instagram posts. To start, what's your Instagram handle?",
      );
      await suspend({ question: 'ig_handle' });
      return undefined as never;
    }
    const igHandle = resumeData.reply.replace(/^@/, '').trim();
    await updateBrand(inputData.brandId, { igHandle });
    return { brandId: inputData.brandId, igHandle };
  },
});

const askBrandDescription = createStep({
  id: 'ask-brand-description',
  inputSchema: z.object({ brandId: z.string(), igHandle: z.string() }),
  outputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string(),
    description: z.string(),
  }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await sendText(
        phone,
        `Got it — @${inputData.igHandle}. In a few sentences, what is your brand about? Who's it for, and what kind of vibe are we going for?`,
      );
      await suspend({ question: 'brand_description' });
      return undefined as never;
    }
    const description = resumeData.reply.trim();

    const voice: BrandVoice = {
      summary: description,
      tone: ['friendly', 'authentic'],
      audience: 'Instagram followers',
      do: ['Be specific', 'Show personality'],
      dont: ['Sound corporate', 'Use empty buzzwords'],
    };
    await updateBrand(inputData.brandId, { voiceJson: voice });

    return { brandId: inputData.brandId, igHandle: inputData.igHandle, description };
  },
});

const askCadence = createStep({
  id: 'ask-cadence',
  inputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string(),
    description: z.string(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string(),
    cadence: z.object({
      postsPerWeek: z.number(),
      preferredHourLocal: z.number().optional(),
    }),
  }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await sendText(
        phone,
        'How often would you like to post? (e.g. "3 a week" or "5 per week, mornings")',
      );
      await suspend({ question: 'cadence' });
      return undefined as never;
    }
    const cadence = parseCadence(resumeData.reply);
    await updateBrand(inputData.brandId, { cadenceJson: cadence });
    return { brandId: inputData.brandId, igHandle: inputData.igHandle, cadence };
  },
});

const askTimezone = createStep({
  id: 'ask-timezone',
  inputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string(),
    cadence: z.object({
      postsPerWeek: z.number(),
      preferredHourLocal: z.number().optional(),
    }),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string(),
    timezone: z.string(),
  }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await sendText(
        phone,
        "Last quick one — what's your timezone? (e.g. America/New_York, Europe/Madrid, or just \"GMT-3\")",
      );
      await suspend({ question: 'timezone' });
      return undefined as never;
    }
    const tz = normalizeTimezone(resumeData.reply);
    await updateBrand(inputData.brandId, { timezone: tz });
    return { brandId: inputData.brandId, igHandle: inputData.igHandle, timezone: tz };
  },
});

const finalize = createStep({
  id: 'finalize',
  inputSchema: z.object({
    brandId: z.string(),
    igHandle: z.string(),
    timezone: z.string(),
  }),
  outputSchema: z.object({ brandId: z.string(), status: z.literal('active') }),
  execute: async ({ inputData }) => {
    const brand = await findBrandById(inputData.brandId);
    if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);
    await updateBrand(inputData.brandId, { status: 'active' });
    const summary = [
      `Perfect, you're all set! 🎉`,
      `• Instagram: @${brand.igHandle}`,
      `• Posts/week: ${brand.cadenceJson?.postsPerWeek ?? '—'}`,
      `• Timezone: ${brand.timezone}`,
      ``,
      `I'll start drafting posts and check in with you over the week. Reply any time if you want to brainstorm something.`,
    ].join('\n');
    await sendText(brand.waPhone, summary);
    logger.info({ brandId: brand.id }, 'Brand onboarding complete');
    return { brandId: inputData.brandId, status: 'active' as const };
  },
});

export const brandOnboardingWorkflow = createWorkflow({
  id: 'brandOnboarding',
  inputSchema: z.object({ brandId: z.string() }),
  outputSchema: z.object({ brandId: z.string(), status: z.literal('active') }),
})
  .then(askIgHandle)
  .then(askBrandDescription)
  .then(askCadence)
  .then(askTimezone)
  .then(finalize)
  .commit();

// ---- helpers ----

function parseCadence(input: string): BrandCadence {
  const numMatch = input.match(/(\d+)/);
  const postsPerWeek = numMatch ? Math.min(21, Math.max(1, Number(numMatch[1]))) : 3;
  const cadence: BrandCadence = { postsPerWeek };
  const lower = input.toLowerCase();
  if (lower.includes('morning')) cadence.preferredHourLocal = 9;
  else if (lower.includes('lunch') || lower.includes('noon') || lower.includes('mid')) cadence.preferredHourLocal = 12;
  else if (lower.includes('afternoon')) cadence.preferredHourLocal = 15;
  else if (lower.includes('evening') || lower.includes('night')) cadence.preferredHourLocal = 19;
  return cadence;
}

function normalizeTimezone(input: string): string {
  const trimmed = input.trim();
  // Already an IANA-looking value: keep it.
  if (/^[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+/.test(trimmed)) return trimmed;
  // Map a few common offsets/cities to IANA. Worst case fall back to UTC.
  const lower = trimmed.toLowerCase();
  if (lower.includes('new york') || lower.includes('nyc') || lower === 'est') return 'America/New_York';
  if (lower.includes('los angeles') || lower.includes('la') || lower === 'pst') return 'America/Los_Angeles';
  if (lower.includes('madrid')) return 'Europe/Madrid';
  if (lower.includes('london') || lower === 'gmt' || lower === 'utc') return 'UTC';
  if (lower.includes('tel aviv') || lower === 'israel') return 'Asia/Jerusalem';
  if (lower.includes('tokyo')) return 'Asia/Tokyo';
  return 'UTC';
}
