import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Single source of truth for Duffy's voice.
 *
 * Both the supervisor `duffy` agent (which talks to brand owners directly)
 * and the stateless `phraseAsDuffy` rewriter used by deterministic
 * onboarding steps embed this same block of rules so every message that
 * reaches the user — whether the supervisor wrote it or a step phrased it
 * for a fixed moment — sounds like one consistent person.
 *
 * If you find yourself adding a voice rule somewhere else, add it here
 * instead.
 */
export const DUFFY_VOICE_RULES = `
VOICE — Duffy
- You are Duffy. ALWAYS write in first-person SINGULAR ("I", "me", "my").
  NEVER use "we", "us", or "our" — you are one assistant, not a team.
- Warm, concise, human. Write like a sharp colleague texting on WhatsApp:
  short paragraphs, no corporate jargon, no hype-bro energy.
- Vary phrasing every time. Don't open with the same words ("awesome —",
  "love it", "amazing"). Read the moment.
- WhatsApp-native: short. Usually one paragraph or two short lines.
- Light, occasional emoji is fine but not required; never more than one per
  message and never emoji spam.
- Sound smart, not robotic. If the user said something off-script, react to
  what they actually said — don't ignore it.
- Don't apologize unless something genuinely went wrong. Don't over-promise.
`.trim();

/**
 * Hard rules for the stateless phrasing rewriter (`phraseAsDuffy`). The
 * supervisor agent gets a richer instruction set on top; this rewriter is
 * intentionally narrow because the calling onboarding step already knows
 * exactly what the message must say.
 */
const PHRASING_INSTRUCTIONS = `
You are Duffy phrasing a single short WhatsApp message. The caller gives you
the moment ("goal"), structured "context", and the facts the message MUST
convey ("mustConvey"). Output ONE message body — that's it.

${DUFFY_VOICE_RULES}

HARD RULES:
- Output ONLY the message body. No quotes, no labels, no JSON, no preamble,
  no sign-off, no "Duffy:" prefix.
- Do NOT call any tools.
- NEVER expose internal metadata: brandId, fromPhone, raw JSON, "[brandId=...]"
  tags, or any other plumbing.
- Preserve every fact in 'mustConvey' — you can rephrase, but don't drop or
  soften critical specifics like "the account is private" or "I couldn't find
  that handle".
- If the goal includes nudging toward a next step (e.g. asking for the IG
  handle), end with a soft, natural ask — not a demand or a bullet list.
`.trim();

let phrasingAgent: Agent | null = null;

function getPhrasingAgent(): Agent {
  if (phrasingAgent) return phrasingAgent;
  const env = loadEnv();
  phrasingAgent = new Agent({
    id: 'duffyPhrasing',
    name: 'Duffy (phrasing)',
    description:
      "Stateless phrasing pass that wraps a fixed onboarding moment in Duffy's voice. No tools, no memory — pure rephrasing.",
    instructions: PHRASING_INSTRUCTIONS,
    model: env.DUFFY_ORCHESTRATOR_MODEL,
  });
  return phrasingAgent;
}

export interface PhraseAsDuffyParams {
  /** What the message is supposed to accomplish at this point in the flow. */
  goal: string;
  /** Concrete facts the rephrased message must preserve in meaning. */
  mustConvey: string;
  /** Hardcoded fallback string used if the LLM call fails or returns empty. Keep this human-readable. */
  fallback: string;
  /** Structured data the model can weave into the message (handle, error reason, user's off-script message, recap fields, etc.). */
  context?: Record<string, unknown>;
  /** Optional override for the default ~280 char soft cap. */
  maxChars?: number;
  /** Optional brandId — used only for log correlation. */
  brandId?: string;
}

/**
 * Returns a short, in-voice WhatsApp message for the given moment.
 *
 * On any failure or empty response, returns `fallback` so the caller never
 * stalls. The caller is responsible for sending the resulting string on the
 * right channel — this helper is pure phrasing.
 */
export async function phraseAsDuffy(params: PhraseAsDuffyParams): Promise<string> {
  const max = params.maxChars ?? 280;

  const userPrompt = [
    `goal: ${params.goal}`,
    `mustConvey: ${params.mustConvey}`,
    `maxChars: ${max}`,
    params.context ? `context: ${JSON.stringify(params.context)}` : null,
    '',
    'Write the WhatsApp message body now. Output text only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await getPhrasingAgent().generate(userPrompt);
    const text = (result as { text?: string }).text?.trim();
    if (!text) return params.fallback;
    return text;
  } catch (err) {
    logger.warn(
      { err, brandId: params.brandId, goal: params.goal },
      'phraseAsDuffy failed; using fallback',
    );
    return params.fallback;
  }
}

/** Test-only: drops the cached phrasing agent so module mocks take effect. */
export function _resetPhrasingAgentForTests(): void {
  phrasingAgent = null;
}
