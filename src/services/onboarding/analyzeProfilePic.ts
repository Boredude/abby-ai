import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { downloadImage, stripGatewayPrefix } from './visionImage.js';

/**
 * Visual analysis of the IG *profile picture*. Profile pics are the most
 * reliable single artifact for the brand's mark + dominant color story:
 * they're hand-picked by the owner, square-cropped for recognition, and
 * usually contain the logo. We run a single-image vision call and ask the
 * model for the brand's palette + a structured logo description.
 *
 * The post-grid analyzer (`analyzeVisuals.ts`) handles every other visual
 * dimension (typography, photo style, composition, lighting, motifs, do/don't).
 */

const paletteEntrySchema = z.object({
  hex: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/u)
    .describe('A 6-digit hex color sampled from the profile picture.')
    .transform((v) => (v.startsWith('#') ? v.toLowerCase() : `#${v.toLowerCase()}`)),
  role: z
    .enum(['primary', 'secondary', 'accent', 'background', 'text', 'other'])
    .describe('Functional role of this color in the brand.'),
  name: z
    .string()
    .max(40)
    .optional()
    .describe('Optional human-friendly name (e.g. "warm sand", "deep navy").'),
});

const logoColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/u)
  .transform((v) => (v.startsWith('#') ? v.toLowerCase() : `#${v.toLowerCase()}`));

// NOTE: Anthropic's structured-output mode rejects `minItems`/`maxItems` > 1,
// so we keep array sizes free in the schema and steer counts via descriptions
// + the prompt instead.
const profilePicAnalysisSchema = z.object({
  palette: z
    .array(paletteEntrySchema)
    .describe(
      '1 to 5 dominant colors actually visible in the profile picture. A single profile pic rarely yields 7 distinct brand colors — do not invent extras.',
    ),
  logo: z
    .object({
      markType: z
        .enum(['wordmark', 'symbol', 'combo', 'monogram', 'none'])
        .describe(
          "What kind of logo is visible. 'wordmark' = brand name as styled text. 'symbol' = pictorial mark / icon only. 'combo' = symbol + wordmark together. 'monogram' = stylized initials. 'none' = the picture is a portrait/photo with no logo.",
        ),
      description: z
        .string()
        .describe(
          'Concrete 10–240 char description of the visible mark (or "no logo — portrait of a person" / similar if markType is none). Mention shape, weight, style, layout.',
        ),
      colors: z
        .array(logoColorSchema)
        .describe(
          'Up to 4 hex colors used on the mark itself (foreground + background). Empty if markType is none.',
        ),
      hasTagline: z
        .boolean()
        .describe('True if the logo includes a small tagline / strapline below the mark.'),
    })
    .describe('Structured description of the brand mark visible in the profile picture.'),
});

export type ProfilePicAnalysis = z.infer<typeof profilePicAnalysisSchema>;

export type AnalyzeProfilePicInput = {
  handle: string;
  profilePicUrl: string;
  brandHint?: string;
};

const SYSTEM_PROMPT = `
You are a senior brand designer extracting the brand's visual identity from a single Instagram profile picture / avatar.
Identify the actual logo (if any) and the colors that genuinely appear in the image.
Be specific and concrete. Never invent colors or a logo that isn't actually visible.
If the picture is a personal portrait with no logo, set markType to "none" and return an empty colors array on the logo.
`.trim();

export async function analyzeInstagramProfilePic(
  input: AnalyzeProfilePicInput,
): Promise<ProfilePicAnalysis> {
  const env = loadEnv();
  const log = logger.child({ analyzer: 'profilePic', handle: input.handle });

  const image = await downloadImage(input.profilePicUrl);

  const modelId = stripGatewayPrefix(env.ONBOARDING_AGENT_MODEL);
  log.info({ modelId, profilePicUrl: input.profilePicUrl }, 'Running profile-pic analysis');

  const userText = [
    `Brand handle: @${input.handle}`,
    input.brandHint ? `Owner-provided context: ${input.brandHint}` : '',
    'I am sending you the brand’s Instagram profile picture.',
    'Extract the dominant brand color palette and a structured description of the logo.',
  ]
    .filter(Boolean)
    .join('\n');

  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: profilePicAnalysisSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image', image: image.bytes, mediaType: image.mediaType },
        ],
      },
    ],
    system: SYSTEM_PROMPT,
  });

  return object;
}
