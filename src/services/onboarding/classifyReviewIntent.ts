import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { normalizeIgHandle } from '../apify/instagramScraper.js';
import { isExplicitApproval } from './recap.js';

/**
 * LLM-driven intent classifier for the brand-kit review reply.
 *
 * After we send the generated brand-board image and ask the user to lock it
 * in / tweak it / try a different handle, their reply can mean any of three
 * things — and a regex check (`isExplicitApproval` + `looksLikeHandle`)
 * misclassifies natural-language replies regularly: "ya looks about right"
 * isn't on the approve whitelist, "yeah perfect, just swap the green" is
 * really an edit, "@nike" might or might not be a handle attempt depending
 * on phrasing.
 *
 * This runs a single Haiku call and disambiguates the entire review-loop
 * sub-state at once. We re-validate any returned handle through
 * `normalizeIgHandle` before trusting it, and on any LLM failure we fall back
 * to `isExplicitApproval` so onboarding never gets fully stuck.
 */

export type ReviewIntent =
  | { intent: 'approve' }
  | { intent: 'new_handle'; handle: string }
  | { intent: 'edit'; editSummary: string }
  | { intent: 'unclear' };

const SYSTEM_PROMPT = `
You classify a user's reply during Instagram brand onboarding. The user has
just been shown a generated "brand board" image (palette, voice, visual
style) derived from their IG account, and asked: do you want to lock it in,
tweak something, or try a different handle?

Decide which of FOUR intents the reply expresses:

1. "approve" — they accept the brand board as-is. Includes anything from a
   plain "yes" to natural confirmations ("ya looks about right", "all good",
   "lock it in", "perfect", "love it", "looks fine", "looks great", "do it",
   "let's go", "sounds good", "go for it", "approved", a thumbs-up emoji).
   No edit request, no new handle, no negation.

2. "new_handle" — they want to try a different Instagram account. The reply
   is a username (with or without @), an instagram.com URL, or contains a
   clear "try X instead" phrasing pointing at a handle. Set the handle field
   to the bare username, lowercase, no @.

3. "edit" — they want to keep the brand board concept but change something.
   This includes mixed replies that contain approval words but also a
   modification ("yes but make it more playful", "lock it in but swap the
   green for navy"). When in doubt between "approve" and "edit", choose
   "edit" — false-positive approvals are worse than asking the user to
   confirm a tweak. Provide a short paraphrase of WHAT to change in
   editSummary (e.g. "more playful", "swap green for navy",
   "use friendlier language").

4. "unclear" — the reply is empty, a question ("what is this?"), small talk
   ("hi"), a confused emoji string, or otherwise doesn't express any of the
   above intents.

Hard rules:
- Output ONLY the JSON object matching the schema. No prose.
- handle: lowercase, bare username, no @ or URL prefix. Null unless intent
  is "new_handle".
- editSummary: short imperative paraphrase. Null unless intent is "edit".
- Negation words ("no", "not", "don't", "nope", "nah") combined with
  modifications mean "edit", not "approve".
- A standalone confirmation word that is also a valid IG username (e.g.
  "ok", "yes", "yea") is "approve", NOT "new_handle".
`.trim();

const reviewIntentSchema = z.object({
  intent: z.enum(['approve', 'new_handle', 'edit', 'unclear']),
  handle: z
    .string()
    .nullable()
    .describe(
      'When intent is "new_handle": the bare Instagram username (lowercase, no @, no URL). Null otherwise.',
    ),
  editSummary: z
    .string()
    .nullable()
    .describe(
      'When intent is "edit": a short imperative paraphrase of the requested change. Null otherwise.',
    ),
  reasoning: z.string().describe('One short sentence explaining the classification.'),
});

function stripGatewayPrefix(modelId: string): string {
  const idx = modelId.indexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}

function fallbackFromRegex(reply: string): ReviewIntent {
  return isExplicitApproval(reply) ? { intent: 'approve' } : { intent: 'unclear' };
}

/**
 * Classifies the user's reply during the brand-kit review sub-state.
 *
 * The optional `currentHandle` is included in the prompt so the model can
 * tell apart a "different handle" reply from a confirmation that happens to
 * resemble a username.
 */
export async function classifyReviewIntent(
  reply: string,
  opts: { currentHandle?: string | null } = {},
): Promise<ReviewIntent> {
  const trimmed = reply?.trim();
  if (!trimmed) return { intent: 'unclear' };

  const env = loadEnv();
  const modelId = stripGatewayPrefix(env.DUFFY_ORCHESTRATOR_MODEL);

  const userMessage = opts.currentHandle
    ? `Currently analyzed handle: @${opts.currentHandle}\nUser reply: "${trimmed}"`
    : `User reply: "${trimmed}"`;

  let object: z.infer<typeof reviewIntentSchema>;
  try {
    const result = await generateObject({
      model: anthropic(modelId),
      schema: reviewIntentSchema,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    object = result.object;
  } catch (err) {
    logger.warn(
      { err, reply: trimmed },
      'classifyReviewIntent failed; falling back to isExplicitApproval',
    );
    return fallbackFromRegex(trimmed);
  }

  switch (object.intent) {
    case 'approve':
      return { intent: 'approve' };
    case 'new_handle': {
      if (!object.handle) {
        logger.warn(
          { reply: trimmed, reasoning: object.reasoning },
          'classifyReviewIntent returned new_handle without a handle; downgrading to unclear',
        );
        return { intent: 'unclear' };
      }
      try {
        return { intent: 'new_handle', handle: normalizeIgHandle(object.handle) };
      } catch {
        logger.warn(
          { reply: trimmed, llmHandle: object.handle, reasoning: object.reasoning },
          'classifyReviewIntent handle did not normalize; downgrading to unclear',
        );
        return { intent: 'unclear' };
      }
    }
    case 'edit': {
      const summary = object.editSummary?.trim() || trimmed;
      return { intent: 'edit', editSummary: summary };
    }
    case 'unclear':
    default:
      return { intent: 'unclear' };
  }
}
