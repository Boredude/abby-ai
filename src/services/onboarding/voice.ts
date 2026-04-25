import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Stateless voice-rewriter for onboarding moments.
 *
 * Each canned `sendText` in the onboarding workflow used to feel scripted and
 * repetitive (especially when the user replied off-script). Instead of
 * hardcoding strings, we describe the *intent* + the *facts that must come
 * across*, and let a cheap LLM (Haiku) phrase a single short WhatsApp message
 * in Duffy's voice. We always keep the original literal as a `fallback` so an
 * LLM hiccup never blocks onboarding.
 *
 * The agent is intentionally stateless (no memory, no tools, no sub-agents) —
 * it's a pure phrasing pass. Brand/conversation memory continues to live on
 * the main Duffy agent.
 */

const VOICE_INSTRUCTIONS = `
You are Duffy's voice for WhatsApp onboarding. Each call gives you the moment
("intent"), structured context, and the facts the message MUST convey. Your
job is to phrase a single short message — and only that.

VOICE:
- Warm, concise, human. Write like a sharp colleague texting — short
  paragraphs, no corporate jargon, no hype-bro energy.
- Vary phrasing every time. Don't open with the same words ("awesome —",
  "love it", "amazing"). Read the moment.
- WhatsApp-native: short. Usually one paragraph or two short lines. Hard cap
  ~280 chars unless the intent explicitly allows more.
- Light, occasional emoji is ok but not required; never more than one per
  message and never emoji spam.
- Sound smart, not robotic. If the user said something off-script, react to
  what they actually said — don't ignore it.
- Don't apologize unless something genuinely went wrong. Don't over-promise.

HARD RULES:
- Output ONLY the message body. No quotes, no labels, no JSON, no preamble,
  no sign-off, no "Duffy:" prefix.
- Do NOT call any tools.
- NEVER expose internal metadata: brandId, fromPhone, intent names, raw JSON,
  "[brandId=...]" tags, or any other plumbing.
- Preserve every fact in 'mustConvey' — you can rephrase, but don't drop or
  soften critical specifics like "the account is private" or "I couldn't find
  that handle".
- If the goal includes nudging toward a next step (e.g. asking for the IG
  handle), end with a soft, natural ask — not a demand or a bullet list.
`.trim();

let voiceAgent: Agent | null = null;
function getVoiceAgent(): Agent {
  if (voiceAgent) return voiceAgent;
  const env = loadEnv();
  voiceAgent = new Agent({
    id: 'duffyVoice',
    name: 'Duffy Voice',
    description: "Stateless voice rewriter that phrases onboarding moments in Duffy's voice.",
    instructions: VOICE_INSTRUCTIONS,
    model: env.DUFFY_ORCHESTRATOR_MODEL,
  });
  return voiceAgent;
}

export type VoiceIntent =
  | 'greet_and_ask_handle'
  | 'ig_handle_invalid_format'
  | 'off_script_during_handle_ask'
  | 'analysis_starting'
  | 'analysis_failed_private'
  | 'analysis_failed_not_found'
  | 'analysis_failed_empty'
  | 'analysis_failed_service_unavailable'
  | 'analysis_failed_retry_handle'
  | 'brand_board_caption'
  | 'review_brand_kit_prompt'
  | 'edit_apply_failed'
  | 'cadence_timezone_question'
  | 'onboarding_complete_summary';

interface IntentBrief {
  /** What the message is supposed to accomplish at this point in the flow. */
  goal: string;
  /** Concrete facts the rephrased message must preserve in meaning. */
  mustConvey: string;
  /** Optional override for the default ~280 char soft cap. */
  maxChars?: number;
}

const INTENT_BRIEFS: Record<VoiceIntent, IntentBrief> = {
  greet_and_ask_handle: {
    goal: 'First message to a brand-new user. Introduce yourself in one breath, say in one short line that you help plan & draft Instagram posts, and ask for their IG handle to get started.',
    mustConvey: 'You are Duffy. You help plan and draft Instagram posts. Ask for their Instagram handle.',
  },
  ig_handle_invalid_format: {
    goal: "The user replied with something that is clearly not an IG handle. Tell them what shape you need (e.g. @nike, nike, or instagram.com link) and re-ask.",
    mustConvey: "What they sent doesn't look like an Instagram handle. You need a username (like @nike or just nike) or an instagram.com link. Ask them to send it again.",
  },
  off_script_during_handle_ask: {
    goal: 'The user replied without a usable Instagram handle. React naturally to what they actually said (answer briefly if it\'s a question, acknowledge if it\'s small talk), then ask them to send the IG handle.',
    mustConvey: "Acknowledge or briefly answer their message in 1 short sentence based on the userMessage in context. Then ask them to send the IG handle (e.g. @theirname). NEVER claim you received their handle, found their account, are setting anything up, or are about to take action — you have NOT received a usable handle yet. Don't say things like \"let me get that set up\" or \"i see it now\".",
    maxChars: 320,
  },
  analysis_starting: {
    goal: "You just got a handle and are starting to scrape & analyze it. Tell them you're looking, and to give you a sec.",
    mustConvey: 'Tell them you are diving into the given handle now and to hold tight for a moment.',
  },
  analysis_failed_private: {
    goal: 'Tell them the IG account they gave is private and you can only analyze public ones. Ask for a different handle.',
    mustConvey: 'The given handle is private. You can only analyze public accounts. Ask for a different handle.',
  },
  analysis_failed_not_found: {
    goal: "Tell them you couldn't find that handle on Instagram. Ask them to double-check the spelling and resend (without the @).",
    mustConvey: "The handle was not found on Instagram. Ask them to double-check spelling and re-send without the @.",
  },
  analysis_failed_empty: {
    goal: 'Tell them the account exists but has no posts you can analyze. Ask for a different handle.',
    mustConvey: 'The account exists but has no posts to analyze yet. Ask for a different handle.',
  },
  analysis_failed_service_unavailable: {
    goal: 'Tell them the analysis temporarily failed on your side. They can reply "retry" in a couple of minutes or send a different handle.',
    mustConvey: 'Temporary error on your side. They can reply "retry" in a couple of minutes, or send a different handle.',
  },
  analysis_failed_retry_handle: {
    goal: "Generic: you couldn't read that account, ask them to send the handle again (without the @) and you'll retry.",
    mustConvey: "You couldn't read that account. Ask them to send the handle again (without the @) and you'll retry.",
  },
  brand_board_caption: {
    goal: 'Caption sent alongside a generated brand-board image of how you read the brand. One short line that asks if it feels right.',
    mustConvey: "This is how you're reading the given handle. Ask if it feels right.",
    maxChars: 160,
  },
  review_brand_kit_prompt: {
    goal: "Right after the brand-board image: invite them to lock it in (YES) or tell you what to tweak. Mention they can also send a different handle to try.",
    mustConvey: 'Reply YES to lock it in, OR tell you what to tweak (give one tiny example like "more playful" or "swap the green for navy"), OR send a different handle to try.',
  },
  edit_apply_failed: {
    goal: "Tell them you hit a snag applying their edit and ask them to rephrase it.",
    mustConvey: 'You hit a snag applying that change. Ask them to rephrase it.',
  },
  cadence_timezone_question: {
    goal: "After the brand kit is locked in. Ask one combined question for posting cadence and timezone. Give tiny examples.",
    mustConvey: 'Ask how often they want to post (example: "3 a week, mornings") AND their timezone (example: America/New_York). One combined ask.',
  },
  onboarding_complete_summary: {
    goal: "Final onboarding message. Confirm everything is set, recap their IG handle, posts/week, and timezone (all in context), then say you'll start drafting and check in over the week.",
    mustConvey: 'Onboarding is done. Recap igHandle, postsPerWeek, and timezone from context. Mention you\'ll start drafting and check in.',
    maxChars: 500,
  },
};

export interface SayInDuffyVoiceParams {
  intent: VoiceIntent;
  /** Structured data the model can weave into the message (handle, error reason, user's off-script message, recap fields, etc.). */
  context?: Record<string, unknown>;
  /** Hardcoded fallback string used if the LLM call fails or returns empty. Keep this human-readable. */
  fallback: string;
  /** Optional brandId — used only for log correlation. */
  brandId?: string;
}

/**
 * Returns a short, in-voice WhatsApp message for the given onboarding moment.
 * On any failure or empty response, returns `fallback` so the workflow never
 * stalls.
 */
export async function sayInDuffyVoice(params: SayInDuffyVoiceParams): Promise<string> {
  const brief = INTENT_BRIEFS[params.intent];
  const max = brief.maxChars ?? 280;

  const userPrompt = [
    `intent: ${params.intent}`,
    `goal: ${brief.goal}`,
    `mustConvey: ${brief.mustConvey}`,
    `maxChars: ${max}`,
    params.context ? `context: ${JSON.stringify(params.context)}` : null,
    '',
    'Write the WhatsApp message body now. Output text only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await getVoiceAgent().generate(userPrompt);
    const text = (result as { text?: string }).text?.trim();
    if (!text) return params.fallback;
    return text;
  } catch (err) {
    logger.warn(
      { err, brandId: params.brandId, intent: params.intent },
      'sayInDuffyVoice failed; using fallback',
    );
    return params.fallback;
  }
}
