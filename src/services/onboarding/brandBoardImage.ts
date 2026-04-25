import { logger } from '../../config/logger.js';
import { updateBrand } from '../../db/repositories/brands.js';
import { generateAndStoreImage } from '../media/generateImage.js';
import type { Brand } from '../../db/schema.js';

/**
 * Builds a deterministic prompt for the brand-board moodboard image. The prompt
 * is composed entirely from the persisted brand JSON (palette, typography,
 * design system, voice) so the same brand state always produces a
 * reproducible-shaped image.
 */
export function buildBrandBoardPrompt(brand: Brand): string {
  const handle = brand.igHandle ?? 'brand';
  const kit = brand.brandKitJson;
  const ds = brand.designSystemJson;
  const voice = brand.voiceJson;

  const lines: string[] = [];

  lines.push(
    'A clean, editorial brand moodboard / brand-board layout — single 1024x1024 square image, magazine-style composition with generous whitespace and organized sections.',
  );
  lines.push(`Centered title across the top: "@${handle} — Brand Board".`);

  if (kit?.palette?.length) {
    const swatches = kit.palette
      .slice(0, 6)
      .map((p) => {
        const label = p.name ? `${p.name} (${p.role})` : p.role;
        return `${p.hex} labeled "${label}"`;
      })
      .join('; ');
    lines.push(
      `Color palette section: a horizontal row of clean rectangular swatches in these exact colors: ${swatches}. Show the hex code under each swatch.`,
    );
  }

  if (kit?.typography?.mood) {
    const sample = kit.typography.sample?.trim() || `@${handle}`;
    lines.push(
      `Typography section: render the word "${sample}" in the typographic style described as "${kit.typography.mood}". Include a one-line note describing that style.`,
    );
  }

  const visualBits: string[] = [];
  if (ds?.photoStyle) visualBits.push(`photo style: ${ds.photoStyle}`);
  if (ds?.illustrationStyle) visualBits.push(`illustration style: ${ds.illustrationStyle}`);
  if (ds?.lighting) visualBits.push(`lighting: ${ds.lighting}`);
  if (ds?.composition) visualBits.push(`composition: ${ds.composition}`);
  if (ds?.recurringMotifs?.length) {
    visualBits.push(`recurring motifs: ${ds.recurringMotifs.slice(0, 3).join(', ')}`);
  }
  if (visualBits.length) {
    lines.push(
      `Imagery / visual style strip: a small representative scene reflecting ${visualBits.join('; ')}.`,
    );
  }

  if (voice?.tone?.length) {
    lines.push(
      `Voice tag row: small chips / tags reading: ${voice.tone.slice(0, 4).join(', ')}.`,
    );
  }
  if (voice?.audience) {
    lines.push(`Caption under the voice tags: "Audience: ${truncate(voice.audience, 100)}".`);
  }

  if (kit?.logoNotes) {
    lines.push(`Logo / mark note (small text in a corner): "${truncate(kit.logoNotes, 120)}".`);
  }

  lines.push(
    'Overall aesthetic: minimal, designerly, like a Behance brand-guidelines page. Use the brand palette colors as the dominant color story. Do not include any people, logos, or brand marks other than the title text.',
  );

  return lines.join(' ');
}

/**
 * Short caption sent on WhatsApp alongside the brand-board image. Keeps the
 * approval prompt itself in `REVIEW_PROMPT` (sent as a separate text message).
 */
export function buildBrandBoardCaption(brand: Brand): string {
  const handle = brand.igHandle ?? 'your brand';
  return `Here's how I'm seeing @${handle} — does this feel right?`;
}

/**
 * Generate the brand-board image for `brand`, upload to R2, persist the
 * resulting URL on the brand row, and return it.
 *
 * Reuses an already-persisted `brandBoardImageUrl` unless `force` is true so
 * we don't burn an extra image generation when the caller is just re-sending
 * the existing board (e.g. on a benign retry). The post-edit path passes
 * `force: true` because the underlying brand kit has changed.
 */
export async function generateBrandBoard(
  brand: Brand,
  opts: { force?: boolean } = {},
): Promise<{ url: string; reused: boolean }> {
  if (!opts.force && brand.brandBoardImageUrl) {
    return { url: brand.brandBoardImageUrl, reused: true };
  }

  const prompt = buildBrandBoardPrompt(brand);
  logger.info({ brandId: brand.id }, 'Generating brand board image');

  const { url } = await generateAndStoreImage({
    prompt,
    size: '1024x1024',
    quality: 'medium',
    ownerId: brand.id,
  });

  await updateBrand(brand.id, { brandBoardImageUrl: url });

  return { url, reused: false };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
