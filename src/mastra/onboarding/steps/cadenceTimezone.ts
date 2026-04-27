import { logger } from '../../../config/logger.js';
import { findBrandById, updateBrand } from '../../../db/repositories/brands.js';
import type { BrandCadence } from '../../../db/schema.js';
import { phraseAsDuffy } from '../../agents/voice.js';
import type { OnboardingStep, OnboardingStepContext, OnboardingStepResult } from '../types.js';

/**
 * Cadence + timezone finalization step. Asks one combined question, parses
 * the reply, marks the brand `active`, and sends the wrap-up summary.
 *
 * Idempotent: if cadence + timezone are already set we treat it as done so
 * re-running the workflow doesn't double-send the summary.
 */

async function executeCadenceTimezone(
  ctx: OnboardingStepContext,
): Promise<OnboardingStepResult> {
  const { brandId, channel, resumeData } = ctx;

  if (!resumeData) {
    await channel.sendText(
      await phraseAsDuffy({
        goal: "After the brand kit is locked in. Ask one combined question for posting cadence and timezone. Give tiny examples.",
        mustConvey:
          'Ask how often they want to post (example: "3 a week, mornings") AND their timezone (example: America/New_York). One combined ask.',
        brandId,
        fallback:
          'Locked in. Two quick last things and I\'m set: how often do you want to post (e.g. "3 a week, mornings") and what\'s your timezone (e.g. America/New_York)?',
      }),
    );
    ctx.suspend({ question: 'cadence_and_timezone' });
  }

  const { cadence, timezone } = parseCadenceAndTimezone(resumeData.reply);
  await updateBrand(brandId, {
    cadenceJson: cadence,
    timezone,
    status: 'active',
  });

  const brand = await findBrandById(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);

  const fallbackSummary = [
    `Perfect, you're all set! 🎉`,
    `• Instagram: @${brand.igHandle}`,
    `• Posts/week: ${cadence.postsPerWeek}`,
    `• Timezone: ${timezone}`,
    ``,
    `I'll start drafting posts and check in with you over the week. Reply any time if you want to brainstorm something.`,
  ].join('\n');
  await channel.sendText(
    await phraseAsDuffy({
      goal: "Final onboarding message. Confirm everything is set, recap their IG handle, posts/week, and timezone (all in context), then say you'll start drafting and check in over the week.",
      mustConvey:
        "Onboarding is done. Recap igHandle, postsPerWeek, and timezone from context. Mention you'll start drafting and check in.",
      brandId: brand.id,
      context: {
        igHandle: brand.igHandle,
        postsPerWeek: cadence.postsPerWeek,
        timezone,
      },
      fallback: fallbackSummary,
      maxChars: 500,
    }),
  );
  logger.info({ brandId: brand.id }, 'Brand onboarding complete');
  return { status: 'done' };
}

export const cadenceTimezoneStep: OnboardingStep = {
  id: 'cadence_timezone',
  displayName: 'Cadence + timezone',
  isComplete(brand) {
    return brand.cadenceJson !== null && brand.status === 'active';
  },
  execute: executeCadenceTimezone,
};

// ---- helpers (lifted as-is from the previous workflow) ----

function parseCadenceAndTimezone(input: string): {
  cadence: BrandCadence;
  timezone: string;
} {
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
  const ianaMatch = trimmed.match(/[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+/);
  if (ianaMatch) return ianaMatch[0];
  const lower = trimmed.toLowerCase();
  if (lower.includes('new york') || lower.includes('nyc') || /\best\b/.test(lower))
    return 'America/New_York';
  if (lower.includes('los angeles') || /\bla\b/.test(lower) || /\bpst\b/.test(lower))
    return 'America/Los_Angeles';
  if (lower.includes('madrid')) return 'Europe/Madrid';
  if (lower.includes('london') || /\bgmt\b/.test(lower) || /\butc\b/.test(lower))
    return 'UTC';
  if (lower.includes('tel aviv') || lower.includes('israel')) return 'Asia/Jerusalem';
  if (lower.includes('tokyo')) return 'Asia/Tokyo';
  return 'UTC';
}
