import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { resolveModel } from './modelResolver.js';
import { stepIdSchema, type EditDirective, type StepId } from './types.js';

/**
 * Map a user's edit note to the set of pipeline steps that should be
 * invalidated + re-run.
 *
 * Examples of expected behavior (for `igSinglePost`):
 *   - "Love the caption, just give me a different photo"
 *        → invalidate=['image']
 *   - "Image is great but the caption feels too corporate"
 *        → invalidate=['copy']  (hashtags then cascade downstream)
 *   - "Completely different angle please"
 *        → invalidate=['ideation']  (everything downstream cascades)
 *   - "Tighter hashtags only"
 *        → invalidate=['hashtags']
 *
 * The cascading (hashtags depending on copy, image depending on
 * artDirection, etc.) is applied later by
 * `expandInvalidatedSteps(contentType, seed)` — this classifier returns the
 * SEED set only.
 */

export type EditIntent = { invalidate: StepId[]; reasoning: string };

const SYSTEM_PROMPT = `
You are the edit-intent classifier for a content-generation pipeline.

You're given:
  - the user's free-text "edit" reply about a draft post that was shown to them
  - a list of pipeline step ids that produced the current draft (e.g.
    ideation, copy, hashtags, artDirection, image)

Decide which steps should be INVALIDATED (re-run from scratch). Return the
minimum set that captures what the user asked to change. Do NOT return the
downstream dependents of those steps — the caller expands those from the
content-type graph.

Heuristics:
  - "new caption" / "rewrite the copy" / "less corporate" / "shorter"
      → ["copy"]
  - "different image" / "another photo" / "try a portrait instead"
      → ["image"]
  - "different look" / "new composition" / "change the lighting"
      → ["artDirection"]
  - "tighter / fewer / different hashtags"
      → ["hashtags"]
  - "completely different idea" / "new angle" / "try something else" /
    "let's try a different topic" → ["ideation"]
  - Mixed requests: include every step the user asked to change.
  - If the reply is vague ("meh", "try again") without specifics, default to
    ["ideation"] — the safest way to produce a materially different draft.

Hard rules:
  - Only emit step ids from the list you're given. Never invent ids.
  - "invalidate" must be non-empty.
  - "reasoning" must be one short sentence explaining your choice.
`.trim();

const editIntentLlmSchema = z.object({
  invalidate: z.array(stepIdSchema).min(1),
  reasoning: z.string(),
});

/**
 * Conservative regex fallback used when the LLM call fails. We bias toward
 * ideation (the "safest reboot"): re-running everything is more expensive
 * but always fulfils the user's implicit ask to see something materially
 * different. Specific keyword hits narrow that down.
 */
function fallbackFromRegex(note: string, availableSteps: readonly StepId[]): EditIntent {
  const has = (id: StepId) => availableSteps.includes(id);
  const n = note.toLowerCase();
  const picks: StepId[] = [];
  if (has('copy') && /(caption|copy|text|words|wording|tone|hook|cta)\b/.test(n)) {
    picks.push('copy');
  }
  if (has('hashtags') && /(hashtag|#|tags?)\b/.test(n)) picks.push('hashtags');
  if (has('image') && /(image|photo|picture|visual|shot|render)\b/.test(n)) picks.push('image');
  if (
    has('artDirection') &&
    /(composition|framing|lighting|palette|colou?r|mood|vibe|style)\b/.test(n)
  ) {
    picks.push('artDirection');
  }
  if (has('ideation') && /(idea|angle|topic|direction|concept|completely different)/.test(n)) {
    picks.push('ideation');
  }
  if (picks.length === 0) {
    return {
      invalidate: has('ideation') ? ['ideation'] : [...availableSteps],
      reasoning: 'fallback: no keyword hit, reboot from ideation',
    };
  }
  return { invalidate: picks, reasoning: 'fallback: keyword match' };
}

export async function classifyEditIntent(input: {
  note: string;
  availableSteps: readonly StepId[];
}): Promise<EditIntent> {
  const { note } = input;
  const availableSteps = input.availableSteps;
  const trimmed = note?.trim();
  if (!trimmed) {
    return {
      invalidate: availableSteps.includes('ideation') ? ['ideation'] : [...availableSteps],
      reasoning: 'empty edit note — full reboot',
    };
  }

  const env = loadEnv();

  const userMessage = [
    `Available step ids: ${availableSteps.join(', ')}`,
    `User edit note: "${trimmed}"`,
  ].join('\n');

  try {
    const { object } = await generateObject({
      model: resolveModel(env.CREATIVE_DIRECTOR_MODEL),
      schema: editIntentLlmSchema,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const invalidate = object.invalidate.filter((id) => availableSteps.includes(id));
    if (invalidate.length === 0) {
      logger.warn(
        { note: trimmed, raw: object },
        'classifyEditIntent returned no valid steps; falling back to regex',
      );
      return fallbackFromRegex(trimmed, availableSteps);
    }
    return { invalidate, reasoning: object.reasoning };
  } catch (err) {
    logger.warn({ err, note: trimmed }, 'classifyEditIntent failed; falling back to regex');
    return fallbackFromRegex(trimmed, availableSteps);
  }
}

/** Convenience: build an EditDirective from the note + classifier result. */
export function buildEditDirective(note: string, intent: EditIntent): EditDirective {
  return { note, invalidate: intent.invalidate };
}
