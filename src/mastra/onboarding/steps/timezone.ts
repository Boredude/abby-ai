import { logger } from '../../../config/logger.js';
import { findPrimaryChannelForBrand } from '../../../db/repositories/brandChannels.js';
import { findBrandById, updateBrand } from '../../../db/repositories/brands.js';
import { inferTimezoneFromPhone, type PhoneTimezoneInference } from '../../../utils/phoneTimezone.js';
import { phraseAsDuffy } from '../../agents/voice.js';
import type { OnboardingStep, OnboardingStepContext, OnboardingStepResult } from '../types.js';

/**
 * Final onboarding step: confirm the brand's timezone, mark them `active`,
 * and send the wrap-up summary. Posting cadence is no longer collected at
 * onboarding — `weeklyPlanning` defaults to 3 posts/week and the user can
 * change it any time via Duffy's `updateBrandContext` tool.
 *
 * Flow:
 *   1. Infer a likely timezone from the user's WhatsApp phone country code.
 *   2. Ask in plain English ("you in Israel, right? Or just tell me your
 *      city.") — never expose IANA strings.
 *   3. On reply: an affirmative locks in the inferred tz; a city/country
 *      goes through `normalizeTimezone`; an unknown reply triggers a soft
 *      re-prompt instead of silently writing `UTC`.
 *
 * Idempotent: the step is treated as done once the brand is `active`, so a
 * re-run of the workflow doesn't re-ask the question.
 */

async function executeTimezone(ctx: OnboardingStepContext): Promise<OnboardingStepResult> {
  const { brandId, channel, resumeData } = ctx;

  const inferred = await loadInferredTimezone(brandId);

  if (!resumeData) {
    await channel.sendText(await buildInitialAsk(brandId, inferred));
    ctx.suspend({ question: 'timezone', inferred: inferred?.timezone ?? null });
  }

  const resolution = resolveTimezoneFromReply(resumeData.reply, inferred);

  if (resolution.kind === 'reprompt') {
    await channel.sendText(await buildSoftReprompt(brandId, inferred));
    ctx.suspend({ question: 'timezone', inferred: inferred?.timezone ?? null, reprompt: true });
  }

  const timezone = resolution.timezone;
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
  logger.info(
    {
      brandId: brand.id,
      timezone,
      inferred: inferred?.timezone ?? null,
      source: resolution.source,
    },
    'Brand onboarding complete',
  );
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

async function loadInferredTimezone(brandId: string): Promise<PhoneTimezoneInference | null> {
  try {
    const channelRow = await findPrimaryChannelForBrand(brandId, 'whatsapp');
    if (!channelRow) return null;
    return inferTimezoneFromPhone(channelRow.externalId);
  } catch (err) {
    logger.warn({ err, brandId }, 'timezone: failed to infer from phone, falling back to open ask');
    return null;
  }
}

async function buildInitialAsk(
  brandId: string,
  inferred: PhoneTimezoneInference | null,
): Promise<string> {
  if (inferred) {
    return phraseAsDuffy({
      goal: 'After the brand kit is locked in. Confirm where they are based, in one short line.',
      mustConvey: `It looks like they're in ${inferred.label}. Ask them to confirm or tell me their city if I got it wrong. Do NOT mention timezones, IANA names, or examples like America/New_York.`,
      brandId,
      context: { guessedLocation: inferred.label },
      fallback: `Locked in. Sounds like you're in ${inferred.label} — that right? Or just tell me your city.`,
    });
  }
  return phraseAsDuffy({
    goal: 'After the brand kit is locked in. Ask in plain English where they are based.',
    mustConvey:
      "Ask where they're based — a city or country is enough. Do NOT mention timezones, IANA names, or examples like America/New_York.",
    brandId,
    fallback: 'Locked in. Last thing — where are you based?',
  });
}

async function buildSoftReprompt(
  brandId: string,
  inferred: PhoneTimezoneInference | null,
): Promise<string> {
  return phraseAsDuffy({
    goal: 'Politely re-ask the location after a reply we could not parse.',
    mustConvey: inferred
      ? `Couldn't tell from that reply. Ask again gently — a city is enough (e.g. Tel Aviv, NYC, London). Do NOT mention timezones or IANA names.`
      : `Couldn't tell from that reply. Ask again gently — a city is enough (e.g. Tel Aviv, NYC, London). Do NOT mention timezones or IANA names.`,
    brandId,
    fallback: 'Sorry, didn\'t catch that — what city are you in? (e.g. Tel Aviv, NYC, London)',
  });
}

type TimezoneResolution =
  | { kind: 'resolved'; timezone: string; source: 'inferred' | 'reply' | 'inferred-fallback' }
  | { kind: 'reprompt' };

const AFFIRMATIVE_RE =
  /^\s*(yes|yeah|yep|yup|y|sure|correct|right|exactly|that'?s right|sounds good|sounds right|👍|מעולה|נכון|כן)\b/i;
const NEGATIVE_RE = /^\s*(no|nope|nah|not really|wrong|incorrect|לא)\b/i;

function resolveTimezoneFromReply(
  rawReply: string,
  inferred: PhoneTimezoneInference | null,
): TimezoneResolution {
  const reply = (rawReply ?? '').trim();

  if (!reply) {
    return { kind: 'reprompt' };
  }

  if (inferred && AFFIRMATIVE_RE.test(reply)) {
    return { kind: 'resolved', timezone: inferred.timezone, source: 'inferred' };
  }

  const normalized = normalizeTimezone(reply);
  if (normalized) {
    return { kind: 'resolved', timezone: normalized, source: 'reply' };
  }

  // Reply was negative or unparseable. Prefer a re-prompt over silently
  // accepting the inferred guess when the user explicitly disagreed.
  if (NEGATIVE_RE.test(reply)) {
    return { kind: 'reprompt' };
  }

  if (inferred) {
    return { kind: 'resolved', timezone: inferred.timezone, source: 'inferred-fallback' };
  }

  return { kind: 'reprompt' };
}

/**
 * Best-effort, deterministic mapping of a free-text reply ("Tel Aviv",
 * "I'm in NYC", "EST") to an IANA timezone. Returns `null` when nothing
 * matches so the caller can re-prompt instead of writing `UTC`.
 */
export function normalizeTimezone(input: string): string | null {
  const trimmed = input.trim();
  const ianaMatch = trimmed.match(/[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+/);
  if (ianaMatch) return ianaMatch[0];

  const lower = trimmed.toLowerCase();

  // Israel
  if (
    lower.includes('tel aviv') ||
    lower.includes('telaviv') ||
    /\btlv\b/.test(lower) ||
    lower.includes('israel') ||
    lower.includes('jerusalem') ||
    lower.includes('haifa')
  )
    return 'Asia/Jerusalem';

  // US — Eastern
  if (
    lower.includes('new york') ||
    /\bnyc\b/.test(lower) ||
    /\best\b/.test(lower) ||
    /\bedt\b/.test(lower) ||
    lower.includes('miami') ||
    lower.includes('boston') ||
    /\bdc\b/.test(lower) ||
    lower.includes('washington')
  )
    return 'America/New_York';

  // US — Central
  if (
    lower.includes('chicago') ||
    lower.includes('dallas') ||
    lower.includes('houston') ||
    lower.includes('austin') ||
    /\bcst\b/.test(lower) ||
    /\bcdt\b/.test(lower)
  )
    return 'America/Chicago';

  // US — Mountain
  if (lower.includes('denver') || /\bmst\b/.test(lower) || /\bmdt\b/.test(lower))
    return 'America/Denver';

  // US — Pacific
  if (
    lower.includes('los angeles') ||
    /\bla\b/.test(lower) ||
    /\bpst\b/.test(lower) ||
    /\bpdt\b/.test(lower) ||
    lower.includes('seattle') ||
    lower.includes('san francisco') ||
    /\bsf\b/.test(lower) ||
    lower.includes('portland')
  )
    return 'America/Los_Angeles';

  // Europe — UK / GMT (note: London is on Europe/London, not UTC)
  if (lower.includes('london') || /\bbst\b/.test(lower)) return 'Europe/London';
  if (/\bgmt\b/.test(lower) || /\butc\b/.test(lower)) return 'UTC';

  // Europe — others
  if (lower.includes('madrid') || lower.includes('barcelona') || lower.includes('valencia') || lower.includes('spain'))
    return 'Europe/Madrid';
  if (lower.includes('paris') || lower.includes('france')) return 'Europe/Paris';
  if (lower.includes('berlin') || lower.includes('munich') || lower.includes('germany'))
    return 'Europe/Berlin';
  if (lower.includes('amsterdam') || lower.includes('netherlands')) return 'Europe/Amsterdam';
  if (lower.includes('lisbon') || lower.includes('portugal')) return 'Europe/Lisbon';
  if (lower.includes('rome') || lower.includes('milan') || lower.includes('italy')) return 'Europe/Rome';
  if (lower.includes('dublin') || lower.includes('ireland')) return 'Europe/Dublin';
  if (lower.includes('zurich') || lower.includes('switzerland')) return 'Europe/Zurich';
  if (lower.includes('stockholm') || lower.includes('sweden')) return 'Europe/Stockholm';

  // Asia / Pacific
  if (lower.includes('tokyo') || lower.includes('japan')) return 'Asia/Tokyo';
  if (lower.includes('singapore')) return 'Asia/Singapore';
  if (lower.includes('hong kong')) return 'Asia/Hong_Kong';
  if (lower.includes('dubai') || lower.includes('uae')) return 'Asia/Dubai';
  if (lower.includes('mumbai') || lower.includes('delhi') || lower.includes('bangalore') || lower.includes('india'))
    return 'Asia/Kolkata';
  if (lower.includes('sydney') || lower.includes('melbourne') || lower.includes('australia'))
    return 'Australia/Sydney';

  // South America
  if (lower.includes('sao paulo') || lower.includes('são paulo') || lower.includes('rio') || lower.includes('brazil'))
    return 'America/Sao_Paulo';
  if (lower.includes('buenos aires') || lower.includes('argentina'))
    return 'America/Argentina/Buenos_Aires';
  if (lower.includes('mexico city') || lower.includes('cdmx') || lower.includes('mexico'))
    return 'America/Mexico_City';

  return null;
}
