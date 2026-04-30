import { logger } from '../../../config/logger.js';
import { findBrandById, updateBrand } from '../../../db/repositories/brands.js';
import { phraseAsDuffy } from '../../agents/voice.js';
import type { OnboardingStep, OnboardingStepContext, OnboardingStepResult } from '../types.js';

/**
 * Final onboarding step: confirm the brand's timezone, mark them `active`,
 * and send the wrap-up summary. Posting cadence is no longer collected at
 * onboarding — `weeklyPlanning` defaults to 3 posts/week and the user can
 * change it any time via Duffy's `updateBrandContext` tool.
 *
 * Idempotent: the step is treated as done once the brand is `active`, so a
 * re-run of the workflow doesn't re-ask the question.
 */

async function executeTimezone(ctx: OnboardingStepContext): Promise<OnboardingStepResult> {
  const { brandId, channel, resumeData } = ctx;

  if (!resumeData) {
    await channel.sendText(
      await phraseAsDuffy({
        goal: "After the brand kit is locked in. Ask one short question for the user's timezone, with a tiny example.",
        mustConvey:
          'Ask for their timezone (example: America/New_York or "Madrid"). One short ask.',
        brandId,
        fallback:
          "Locked in. Last thing — what timezone are you in? (e.g. America/New_York or just the city.)",
      }),
    );
    ctx.suspend({ question: 'timezone' });
  }

  const timezone = normalizeTimezone(resumeData.reply);
  await updateBrand(brandId, {
    timezone,
    status: 'active',
  });

  const brand = await findBrandById(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);

  const fallbackSummary = [
    `Perfect, you're all set!`,
    `• Instagram: @${brand.igHandle}`,
    `• Timezone: ${timezone}`,
    ``,
    `I'll start drafting posts and check in with you over the week. Reply any time if you want to brainstorm something.`,
  ].join('\n');
  await channel.sendText(
    await phraseAsDuffy({
      goal: "Final onboarding message. Confirm everything is set, recap their IG handle and timezone (both in context), then say you'll start drafting and check in over the week.",
      mustConvey:
        "Onboarding is done. Recap igHandle and timezone from context. Mention you'll start drafting and check in.",
      brandId: brand.id,
      context: {
        igHandle: brand.igHandle,
        timezone,
      },
      fallback: fallbackSummary,
      maxChars: 500,
    }),
  );
  logger.info({ brandId: brand.id }, 'Brand onboarding complete');
  return { status: 'done' };
}

export const timezoneStep: OnboardingStep = {
  id: 'timezone',
  displayName: 'Timezone',
  isComplete(brand) {
    return brand.status === 'active';
  },
  execute: executeTimezone,
};

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
