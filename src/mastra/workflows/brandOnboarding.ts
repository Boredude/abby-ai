import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { findBrandById, updateBrand } from '../../db/repositories/brands.js';
import { sendText } from '../../services/kapso/client.js';
import { logger } from '../../config/logger.js';
import { getAbbyAgent } from '../agents/abby.js';
import type { BrandCadence } from '../../db/schema.js';

/**
 * Brand onboarding workflow (v2 — agent-driven).
 *
 * The new flow does the bare minimum of structured Q&A and lets the
 * OnboardingAgent (delegated by Abby) do the heavy lifting:
 *
 *   1. ask-ig-handle              → ask only for the IG handle.
 *   2. run-analysis-and-confirm   → kick off Abby, who delegates to
 *      OnboardingAgent. The agent fetches IG, runs visual + voice analyses,
 *      saves the brand kit, then sends the recap on WA. We suspend here
 *      until the user confirms or asks for edits.
 *   3. ask-cadence-timezone-or-finalize → one combined question for cadence
 *      + timezone, then mark the brand active.
 *
 * Each step that asks the user suspends; the Kapso webhook resumes the run
 * with the user's reply via the inbound dispatcher.
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

const runAnalysisAndConfirm = createStep({
  id: 'run-analysis-and-confirm',
  inputSchema: z.object({ brandId: z.string(), igHandle: z.string() }),
  outputSchema: z.object({ brandId: z.string(), confirmed: z.boolean() }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);

      await sendText(
        phone,
        `Awesome — diving into @${inputData.igHandle} now. Give me a moment to study your feed and I'll come back with a brand kit you can tweak.`,
      );

      try {
        const abby = getAbbyAgent();
        const prompt = [
          `[brandId=${inputData.brandId}]`,
          `The user just confirmed their Instagram handle: @${inputData.igHandle}.`,
          `Their brand profile has no brand kit yet. Delegate to onboardingAgent`,
          `with this brandId and handle. When it returns, lightly reformat the recap`,
          `into your warm WhatsApp voice and send it to the user, ending with`,
          `"Want me to lock this in or tweak anything?"`,
        ].join(' ');

        const result = await abby.generate(prompt, {
          memory: { thread: `brand:${inputData.brandId}`, resource: inputData.brandId },
        });
        const reply = (result as { text?: string }).text?.trim() ?? '';
        if (reply) await sendText(phone, reply);
      } catch (err) {
        logger.error({ err, brandId: inputData.brandId }, 'Onboarding analysis failed');
        await sendText(
          phone,
          "Hmm, I couldn't read that account. Make sure it's public and the handle is right? Reply with your handle (without the @) and I'll try again.",
        );
      }

      await suspend({ question: 'brand_kit_confirmation' });
      return undefined as never;
    }

    const lower = resumeData.reply.toLowerCase();
    const wantsEdits =
      /\b(edit|tweak|change|wrong|fix|update|nope|no\b|different|swap)\b/.test(lower);

    if (wantsEdits) {
      const phone = await getBrandPhone(inputData.brandId);
      try {
        const abby = getAbbyAgent();
        const prompt = [
          `[brandId=${inputData.brandId}]`,
          `The user wants to edit the brand kit. Their feedback: "${resumeData.reply}".`,
          `Update the brand profile via updateBrandProfile if needed and confirm the change in a short message.`,
        ].join(' ');
        const result = await abby.generate(prompt, {
          memory: { thread: `brand:${inputData.brandId}`, resource: inputData.brandId },
        });
        const reply = (result as { text?: string }).text?.trim() ?? '';
        if (reply) await sendText(phone, reply);
      } catch (err) {
        logger.error({ err, brandId: inputData.brandId }, 'Brand kit edit handling failed');
      }
      // Stay in this step — suspend again until user confirms.
      await suspend({ question: 'brand_kit_confirmation' });
      return undefined as never;
    }

    return { brandId: inputData.brandId, confirmed: true };
  },
});

const askCadenceTimezoneOrFinalize = createStep({
  id: 'ask-cadence-timezone-or-finalize',
  inputSchema: z.object({ brandId: z.string(), confirmed: z.boolean() }),
  outputSchema: z.object({ brandId: z.string(), status: z.literal('active') }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await sendText(
        phone,
        "Locked in. Two quick last things and we're set: how often do you want to post (e.g. \"3 a week, mornings\") and what's your timezone (e.g. America/New_York)?",
      );
      await suspend({ question: 'cadence_and_timezone' });
      return undefined as never;
    }

    const { cadence, timezone } = parseCadenceAndTimezone(resumeData.reply);
    await updateBrand(inputData.brandId, {
      cadenceJson: cadence,
      timezone,
      status: 'active',
    });

    const brand = await findBrandById(inputData.brandId);
    if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);

    const summary = [
      `Perfect, you're all set! 🎉`,
      `• Instagram: @${brand.igHandle}`,
      `• Posts/week: ${cadence.postsPerWeek}`,
      `• Timezone: ${timezone}`,
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
  .then(runAnalysisAndConfirm)
  .then(askCadenceTimezoneOrFinalize)
  .commit();

// ---- helpers ----

function parseCadenceAndTimezone(input: string): { cadence: BrandCadence; timezone: string } {
  return {
    cadence: parseCadence(input),
    timezone: normalizeTimezone(input),
  };
}

function parseCadence(input: string): BrandCadence {
  const numMatch = input.match(/(\d+)/);
  const postsPerWeek = numMatch ? Math.min(21, Math.max(1, Number(numMatch[1]))) : 3;
  const cadence: BrandCadence = { postsPerWeek };
  const lower = input.toLowerCase();
  if (lower.includes('morning')) cadence.preferredHourLocal = 9;
  else if (lower.includes('lunch') || lower.includes('noon') || lower.includes('mid'))
    cadence.preferredHourLocal = 12;
  else if (lower.includes('afternoon')) cadence.preferredHourLocal = 15;
  else if (lower.includes('evening') || lower.includes('night')) cadence.preferredHourLocal = 19;
  return cadence;
}

function normalizeTimezone(input: string): string {
  const trimmed = input.trim();
  // Already an IANA-looking value: keep the first matching token.
  const ianaMatch = trimmed.match(/[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+/);
  if (ianaMatch) return ianaMatch[0];
  const lower = trimmed.toLowerCase();
  if (lower.includes('new york') || lower.includes('nyc') || /\best\b/.test(lower))
    return 'America/New_York';
  if (lower.includes('los angeles') || /\bla\b/.test(lower) || /\bpst\b/.test(lower))
    return 'America/Los_Angeles';
  if (lower.includes('madrid')) return 'Europe/Madrid';
  if (lower.includes('london') || /\bgmt\b/.test(lower) || /\butc\b/.test(lower)) return 'UTC';
  if (lower.includes('tel aviv') || lower.includes('israel')) return 'Asia/Jerusalem';
  if (lower.includes('tokyo')) return 'Asia/Tokyo';
  return 'UTC';
}
