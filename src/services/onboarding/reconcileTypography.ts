import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { BrandKit } from '../../db/schema.js';
import type { WebsiteAnalysis } from './analyzeWebsite.js';
import { stripGatewayPrefix } from './visionImage.js';

/**
 * Reconcile two contradictory-but-individually-valid typography signals into
 * a single coherent brand-kit typography object:
 *
 *  - **Visual mood from the IG post grid** (e.g. "Elegant serif with script
 *    italics, romantic, handwritten refinement"). Inferred from photo
 *    *content* — flowers, weddings, captions on photos. Often beautiful, but
 *    has zero grounding in the brand's actual *typography*.
 *  - **Real font names from the brand's website** (e.g. "Lexend Deca" for
 *    headings, "Inter" for body). Pulled out of declared CSS — fully
 *    grounded in real type.
 *
 * The deterministic synthesizer concatenates these with " — primary type:"
 * and that produces internally contradictory prompts when the IG vibe
 * disagrees with the actual fonts. This module asks an LLM to *choose*
 * which signal to lead with and produce a single mood string that doesn't
 * contradict the structured fontFamilies / heading / body fields.
 *
 * The output is a `BrandKit['typography']` value the synthesizer can use
 * verbatim. On any failure we return `null` so the caller falls back to the
 * deterministic `buildTypography` baked into `synthesizeBrandKit`.
 */

const reconciledSchema = z.object({
  mood: z
    .string()
    .min(10)
    .max(280)
    .describe(
      "A single coherent description of the brand's typography that does NOT contradict the chosen fonts. 10–280 chars. Reference the actual font names when they're available — e.g. 'Clean modern sans-serif system: Lexend Deca for headings, Inter for body.' Avoid corporate fluff.",
    ),
  source: z
    .enum(['website', 'instagram'])
    .describe(
      "Which signal you primarily relied on. Use 'website' whenever website fonts were provided (they are the brand's actual declared typography). Use 'instagram' only when no website fonts exist.",
    ),
  headingFont: z
    .string()
    .optional()
    .describe(
      "Heading font name. ONLY include when website fonts were provided. Pick the website's headingFont when present, otherwise the first website font.",
    ),
  bodyFont: z
    .string()
    .optional()
    .describe(
      "Body font name. ONLY include when website fonts were provided. Pick the website's bodyFont when present, otherwise a different second website font if any.",
    ),
});

type Reconciled = z.infer<typeof reconciledSchema>;

export type ReconcileTypographyInput = {
  handle: string;
  /** IG visual analyzer's typographyMood string (always present). */
  visualTypographyMood: string;
  website?: WebsiteAnalysis;
  brandHint?: string;
};

const SYSTEM_PROMPT = `
You are a senior brand designer reconciling two typography signals into one coherent description for a brand-board moodboard prompt.

You will receive:
  • An "IG visual mood" string inferred from the look-and-feel of the brand's Instagram POST CONTENT (photos, captions, stickers — NOT actual typography).
  • Optional "Website fonts" — the actual font-family declarations parsed out of the brand's website CSS. When present, these are the brand's REAL typography.

Rules:
  1. When website fonts are provided, treat them as authoritative. The mood string MUST reference those exact font names and MUST NOT describe a typographic style that contradicts what those fonts look like (e.g. don't call Lexend Deca / Inter "elegant serif with script italics" — they are clean geometric sans).
  2. When NO website fonts are provided, fall back to the IG visual mood verbatim — that's the best signal we have.
  3. Never invent font names that weren't provided.
  4. Output a single sentence (10–280 chars). No corporate fluff. No mention of "this brand" or "the brand"; describe the type system directly.
  5. Set 'source' to 'website' whenever website fonts were provided, even if you also drew context from the IG mood. Use 'instagram' only when the website signal is absent.
`.trim();

function buildUserText(input: ReconcileTypographyInput): string {
  const lines = [`Brand handle: @${input.handle}`];
  if (input.brandHint) lines.push(`Owner-provided context: ${input.brandHint}`);
  lines.push('');
  lines.push(`IG visual mood (inferred from photo content, NOT actual type): "${input.visualTypographyMood}"`);
  lines.push('');
  if (input.website) {
    const w = input.website;
    lines.push('Website fonts (the brand\'s actual declared typography):');
    if (w.headingFont) lines.push(`  • headingFont: ${w.headingFont}`);
    if (w.bodyFont) lines.push(`  • bodyFont: ${w.bodyFont}`);
    if (w.fontFamilies.length > 0) {
      lines.push(`  • fontFamilies (in declaration order): ${w.fontFamilies.join(', ')}`);
    }
    if (w.googleFonts.length > 0) {
      lines.push(`  • googleFonts (loaded via fonts.googleapis.com): ${w.googleFonts.join(', ')}`);
    }
    if (w.pageTitle) lines.push(`  • pageTitle: ${w.pageTitle}`);
    lines.push(`  • resolvedUrl: ${w.resolvedUrl}`);
  } else {
    lines.push('Website fonts: NOT AVAILABLE — fall back to the IG visual mood.');
  }
  lines.push('');
  lines.push('Produce a single coherent typography description following the rules.');
  return lines.join('\n');
}

/**
 * Best-effort LLM reconciliation. Returns the structured typography object
 * for the brand kit, or `null` if the call failed (or the model returned a
 * value the schema rejected). Callers should treat `null` as "use the
 * deterministic fallback".
 */
export async function reconcileTypography(
  input: ReconcileTypographyInput,
): Promise<BrandKit['typography'] | null> {
  const env = loadEnv();
  const log = logger.child({ analyzer: 'reconcileTypography', handle: input.handle });
  const modelId = stripGatewayPrefix(env.ONBOARDING_AGENT_MODEL);

  let reconciled: Reconciled;
  try {
    const { object } = await generateObject({
      model: anthropic(modelId),
      schema: reconciledSchema,
      messages: [{ role: 'user', content: buildUserText(input) }],
      system: SYSTEM_PROMPT,
    });
    reconciled = object;
  } catch (err) {
    log.warn({ err }, 'Typography reconciliation failed; using deterministic fallback');
    return null;
  }

  // Extra defensive trims: if the website signal is present, force the
  // structured font fields back to the actual website fonts even if the
  // model paraphrased / dropped them. The mood string we trust verbatim.
  const website = input.website;
  if (website) {
    const websiteFamilies = website.fontFamilies.length > 0 ? website.fontFamilies : undefined;
    const headingFont = website.headingFont ?? reconciled.headingFont ?? websiteFamilies?.[0];
    const bodyFont =
      website.bodyFont ??
      reconciled.bodyFont ??
      (websiteFamilies && websiteFamilies.length > 1 ? websiteFamilies[1] : undefined);
    log.info(
      { source: 'website', headingFont, bodyFont, families: websiteFamilies?.length ?? 0 },
      'Typography reconciled (website-primary)',
    );
    return {
      mood: reconciled.mood,
      source: 'website',
      ...(headingFont ? { headingFont } : {}),
      ...(bodyFont ? { bodyFont } : {}),
      ...(websiteFamilies ? { fontFamilies: websiteFamilies } : {}),
    };
  }

  // No website — IG-only path. Strip any font fields the model hallucinated.
  log.info({ source: 'instagram' }, 'Typography reconciled (instagram-only)');
  return { mood: reconciled.mood, source: 'instagram' };
}
