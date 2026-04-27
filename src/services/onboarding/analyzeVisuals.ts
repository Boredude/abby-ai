import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Visual analysis of an Instagram brand.
 *
 * Two input shapes are supported:
 *
 *  - `source: 'grid'`  — viewport screenshots taken by our headless Chromium
 *    grid-capture worker (each shot shows ~12 tiles in their grid context),
 *    plus an optional avatar. Preferred when available; gives the model a
 *    truer sense of the brand than individual post crops.
 *
 *  - `source: 'posts'` — original behaviour: individual post images returned
 *    by Apify's `details` scrape. Used as a fallback when grid capture is
 *    disabled or fails.
 *
 * Both branches converge on the same Claude vision call + zod schema, so the
 * downstream `synthesizeBrandKit` shape is unchanged.
 *
 * The hard cap exists as a defensive guard against accidental input
 * blow-ups; in practice we send ~12 (post fallback) or ~10–15 (grid).
 */

const MAX_IMAGES = 24;

const paletteEntrySchema = z.object({
  hex: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/u)
    .describe('A 6-digit hex color sampled from the brand visuals.')
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

// NOTE: Anthropic's structured-output mode rejects `minItems`/`maxItems` > 1,
// so we keep array sizes free in the schema and steer counts via descriptions
// + the prompt instead.
const visualAnalysisSchema = z.object({
  palette: z
    .array(paletteEntrySchema)
    .describe('3 to 7 dominant colors that define the brand on Instagram.'),
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

export type AnalyzeVisualsInput =
  | {
      handle: string;
      source: 'posts';
      imageUrls: string[];
      brandHint?: string;
    }
  | {
      handle: string;
      source: 'grid';
      /** Viewport screenshots from the headless Chromium grid capture. */
      viewportShotUrls: string[];
      /** Optional avatar image URL captured alongside the grid. */
      profilePicUrl?: string;
      brandHint?: string;
    };

const SYSTEM_PROMPT_POSTS = `
You are a senior brand designer auditing an Instagram feed.
Look at every image carefully and synthesize a coherent visual brand identity.
Be specific and actionable — this output will be used to generate future on-brand visuals.
Use concrete adjectives, not corporate fluff. Never invent colors or motifs that aren't actually in the images.
`.trim();

const SYSTEM_PROMPT_GRID = `
You are a senior brand designer auditing an Instagram feed.

The images you are about to see are SCREENSHOTS of the brand's Instagram profile page,
captured at viewport size as we scroll down the grid. Each screenshot therefore shows
multiple post tiles arranged in their actual on-feed layout (typically a 3-column grid),
plus the surrounding chrome (header, bio, action bar). When an avatar image is included
it will be a single, smaller square shown separately from the grid screenshots.

Reason about the brand by treating each screenshot as a slice of the grid. Pay special
attention to how the tiles relate to each other — recurring colors, consistent crop
ratios, typographic motifs, repeated subject matter, the rhythm between text-heavy and
photo-heavy posts. Ignore Instagram chrome (icons, follower counts, "Follow" buttons,
the profile header) when extracting the brand identity.

Be specific and actionable — this output will be used to generate future on-brand visuals.
Use concrete adjectives, not corporate fluff. Never invent colors or motifs that aren't
actually visible in the screenshots.
`.trim();

export async function analyzeInstagramVisuals(input: AnalyzeVisualsInput): Promise<VisualAnalysis> {
  const env = loadEnv();
  const log = logger.child({ analyzer: 'visuals', handle: input.handle, source: input.source });

  // Collect the list of URLs to download in priority order. For the grid
  // path the avatar (if present) goes last so it doesn't crowd out the grid
  // shots when we hit MAX_IMAGES; for the posts path we send what we have.
  const urls: string[] =
    input.source === 'grid'
      ? [
          ...input.viewportShotUrls,
          ...(input.profilePicUrl ? [input.profilePicUrl] : []),
        ].slice(0, MAX_IMAGES)
      : input.imageUrls.slice(0, MAX_IMAGES);
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

  const description =
    input.source === 'grid'
      ? `I'm sending you ${images.length} viewport screenshots of the brand's Instagram profile page in scroll order${
          input.profilePicUrl ? ' (the last image is the avatar)' : ''
        }.`
      : `I'm sending you ${images.length} recent Instagram posts in order.`;

  const userText = [
    `Brand handle: @${input.handle}`,
    input.brandHint ? `Owner-provided context: ${input.brandHint}` : '',
    description,
    'Extract the brand kit + design system that ties them together.',
  ]
    .filter(Boolean)
    .join('\n');

  const system = input.source === 'grid' ? SYSTEM_PROMPT_GRID : SYSTEM_PROMPT_POSTS;

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
    system,
  });

  return object;
}

/**
 * Download an image and return the raw bytes + the MIME type to declare to
 * the model. Anthropic accepts jpeg/png/gif/webp; if the server doesn't tell
 * us a usable type, we fall back to image/jpeg (which is what IG's CDN
 * actually serves).
 */
async function downloadImage(url: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const res = await fetch(url, {
    headers: {
      // IG CDN sometimes returns 403 without a browsery UA / referer.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      referer: 'https://www.instagram.com/',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching image`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const mediaType =
    ct.startsWith('image/jpeg') || ct.startsWith('image/jpg')
      ? 'image/jpeg'
      : ct.startsWith('image/png')
        ? 'image/png'
        : ct.startsWith('image/webp')
          ? 'image/webp'
          : ct.startsWith('image/gif')
            ? 'image/gif'
            : 'image/jpeg';
  return { bytes: buf, mediaType };
}

/**
 * Mastra model ids look like "anthropic/claude-sonnet-4-5"; the AI SDK's
 * `anthropic(...)` factory just wants the bare model id.
 */
function stripGatewayPrefix(modelId: string): string {
  const idx = modelId.indexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}
