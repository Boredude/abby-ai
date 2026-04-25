import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  extractHandleFromMessage,
  normalizeIgHandle,
} from '../apify/instagramScraper.js';

/**
 * LLM-driven Instagram handle extraction for free-form replies.
 *
 * The strict regex-based `extractHandleFromMessage` is brittle: it can't tell
 * "Yea" (a confirmation) apart from "yea" the username, and it can't pull a
 * handle out of "It's ob.cocktails" because there's no `@` or URL marker. We
 * run a small Haiku call that, given conversational context, decides whether
 * the user actually shared a handle in this message and returns just the
 * username — or null if the message is acknowledgment, a question, small
 * talk, or otherwise not a handle.
 *
 * The LLM result is always re-validated with `normalizeIgHandle` so we never
 * hand the scraper anything malformed. On any LLM failure we fall back to the
 * regex extractor so onboarding never gets fully stuck.
 */

const SYSTEM_PROMPT = `
You extract Instagram handles from natural-language WhatsApp replies during
onboarding. The user has just been asked for their Instagram handle. Your job
is to decide, for ONE reply, whether the user actually shared a handle in
this message and, if so, return the bare username.

Return { handle: "<username>" } only when the user clearly provided a handle.
A handle may be:
- A standalone username (with or without @): "nike", "@ob.cocktails"
- An embedded mention: "It's ob.cocktails", "my handle is @ob.cocktails",
  "use ob_cocktails please"
- An instagram.com URL: "https://instagram.com/ob.cocktails"

Return { handle: null } when the user did NOT share a handle. This includes:
- Confirmations / acknowledgments: "yes", "yea", "yeah", "yep", "ok", "sure",
  "cool", "got it", "correct", "right", "exactly", "thanks"
  (Even though words like "yea" technically match the username character
  set, they are NOT handles in this context.)
- Questions: "what?", "wdym?", "what can you do?", "is that the same as
  username?"
- Confusion or small talk: "hi", "hey", "what's up", "lol"
- Negations / refusals: "no", "not really", "skip", "later"
- Generic statements without a handle name: "I have one", "give me a sec",
  "checking my phone"

Hard rules:
- Output ONLY the JSON object matching the schema. No prose.
- The handle must be the username only — no @, no URL, no domain, no spaces,
  lowercase. Strip leading @ and any trailing slash.
- If multiple plausible handles appear, return the one most clearly being
  offered as theirs.
- When in doubt, return null. False negatives ("ask again") are much cheaper
  than false positives ("scrape the wrong account").
- Common English words ("yea", "yes", "ok", "sure", "no", "lol", "hi") are
  NEVER handles here, even when nothing else is in the message.
`.trim();

const extractionSchema = z.object({
  handle: z
    .string()
    .nullable()
    .describe(
      'The Instagram username (no @ prefix, no URL, lowercase) the user provided in this message, or null if no handle was clearly shared.',
    ),
  reasoning: z
    .string()
    .describe('One short sentence explaining what you read in the message.'),
});

function stripGatewayPrefix(modelId: string): string {
  const idx = modelId.indexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}

/**
 * Returns a normalized Instagram username if the reply clearly contains one,
 * or null if it doesn't. Uses an LLM with conversational context, then
 * re-validates the result with `normalizeIgHandle`. Falls back to the regex
 * extractor on any LLM error.
 */
export async function extractHandleWithLLM(reply: string): Promise<string | null> {
  const trimmed = reply?.trim();
  if (!trimmed) return null;

  const env = loadEnv();
  const modelId = stripGatewayPrefix(env.DUFFY_ORCHESTRATOR_MODEL);

  try {
    const { object } = await generateObject({
      model: anthropic(modelId),
      schema: extractionSchema,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `User reply: "${trimmed}"` }],
    });

    if (!object.handle) return null;

    try {
      return normalizeIgHandle(object.handle);
    } catch {
      logger.warn(
        { reply: trimmed, llmHandle: object.handle, reasoning: object.reasoning },
        'LLM extracted handle did not normalize; treating as no extraction',
      );
      return null;
    }
  } catch (err) {
    logger.warn(
      { err, reply: trimmed },
      'extractHandleWithLLM failed; falling back to regex extractor',
    );
    return extractHandleFromMessage(trimmed);
  }
}
