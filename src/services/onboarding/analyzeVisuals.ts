import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { downloadImage, stripGatewayPrefix } from './visionImage.js';

/**
 * Visual analysis of an Instagram brand's *post grid*. We feed every post
 * image we have for the IG grid (typically 12 — Apify's `details` mode
 * returns the most recent 12 posts) into a single multi-image vision call
 * and ask Claude Sonnet to extract the design system the posts share:
 * typography mood, illustration style, photo style, composition, lighting,
 * recurring motifs, and visual do's / don'ts.
 *
 * The brand's color palette and logo are intentionally NOT extracted here —
 * they come from the profile-picture analyzer (`analyzeProfilePic.ts`)
 * because the avatar is the most reliable source for the brand's mark and
 * core color story.
 *
 * The hard cap exists only as a defensive guard against accidental input
 * blow-ups; in practice the scraper returns ~12.
 */

const MAX_IMAGES = 24;

// NOTE: Anthropic's structured-output mode rejects `minItems`/`maxItems` > 1,
// so we keep array sizes free in the schema and steer counts via descriptions
// + the prompt instead.
const visualAnalysisSchema = z.object({
  typographyMood: z
    .string()
    .describe('Short description of the typographic feel (serif/sans, weight, tone), 10–200 chars.'),
  photoStyle: z.string().describe('Photo style description, 10–300 chars.'),
  illustrationStyle: z
    .string()
    .describe('Illustration/graphic style description; empty string if none, otherwise up to 300 chars.'),
  composition: z.string().describe('Composition style description, 10–300 chars.'),
  lighting: z.string().describe('Lighting style description, 10–300 chars.'),
  recurringMotifs: z
    .array(z.string())
    .describe('Up to 8 recurring motifs/objects/themes (2–60 chars each); empty if none.'),
  doVisuals: z
    .array(z.string())
    .describe('2 to 8 short do-this guidelines for visuals (2–120 chars each).'),
  dontVisuals: z
    .array(z.string())
    .describe("2 to 8 short avoid-this guidelines for visuals (2–120 chars each)."),
});

export type VisualAnalysis = z.infer<typeof visualAnalysisSchema>;

export type AnalyzeVisualsInput = {
  handle: string;
  imageUrls: string[];
  brandHint?: string;
};

const SYSTEM_PROMPT = `
You are a senior brand designer auditing an Instagram feed.
Look at every image carefully and synthesize the coherent design system that ties the grid together.
Focus on typography mood, illustration style, photo style, composition, lighting, recurring motifs, and concrete do/don't guidelines.
Do NOT extract a color palette or logo — those come from a separate pass on the profile picture.
Be specific and actionable — this output will be used to generate future on-brand visuals.
Use concrete adjectives, not corporate fluff. Never invent motifs that aren't actually in the images.
`.trim();

export async function analyzeInstagramVisuals(input: AnalyzeVisualsInput): Promise<VisualAnalysis> {
  const env = loadEnv();
  const log = logger.child({ analyzer: 'visuals', handle: input.handle });

  const urls = input.imageUrls.slice(0, MAX_IMAGES);
  if (urls.length === 0) {
    throw new Error('analyzeInstagramVisuals: no image URLs provided');
  }

  // Anthropic fetches URL-based images themselves and respects the target's
  // robots.txt. Instagram's CDN disallows that, so we download the bytes here
  // and send them inline. Failed downloads are skipped so a single broken/
  // expired CDN URL doesn't kill the whole analysis.
  const fetched = await Promise.all(
    urls.map(async (url, idx) => {
      try {
        return await downloadImage(url);
      } catch (err) {
        log.warn({ err, url, idx }, 'Failed to download IG image; skipping');
        return null;
      }
    }),
  );
  const images = fetched.filter((x): x is { bytes: Uint8Array; mediaType: string } => x !== null);
  if (images.length === 0) {
    throw new Error('analyzeInstagramVisuals: every image download failed');
  }

  const modelId = stripGatewayPrefix(env.ONBOARDING_AGENT_MODEL);
  log.info(
    { modelId, requested: urls.length, sent: images.length },
    'Running visual analysis',
  );

  const userText = [
    `Brand handle: @${input.handle}`,
    input.brandHint ? `Owner-provided context: ${input.brandHint}` : '',
    `I'm sending you ${images.length} recent Instagram posts in order.`,
    'Extract the design system that ties them together (typography mood, illustration style, photo style, composition, lighting, motifs, do/don\'t).',
  ]
    .filter(Boolean)
    .join('\n');

  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: visualAnalysisSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...images.map((img) => ({
            type: 'image' as const,
            image: img.bytes,
            mediaType: img.mediaType,
          })),
        ],
      },
    ],
    system: SYSTEM_PROMPT,
  });

  return object;
}
