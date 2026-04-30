import { logger } from '../../config/logger.js';
import { updateBrand } from '../../db/repositories/brands.js';
import { generateAndStoreImage, type ReferenceImage } from '../media/generateImage.js';
import type { Brand } from '../../db/schema.js';
import { downloadImage } from './visionImage.js';

/**
 * Builds a deterministic prompt for the brand-board moodboard image used as
 * the FALLBACK path — pure text-to-image, no reference images. The prompt is
 * composed entirely from the persisted brand JSON (palette, typography,
 * design system, voice) so the same brand state always produces a
 * reproducible-shaped image.
 *
 * The primary path is `buildBrandBoardPromptWithRefs` + `images.edit` with
 * the brand's actual profile pic + top posts as references. We only fall
 * back to this text-only prompt when no profile picture is available or
 * the reference downloads all failed.
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
    const heading = kit.typography.headingFont;
    const body = kit.typography.bodyFont;
    const fontHint =
      heading && body && heading.toLowerCase() !== body.toLowerCase()
        ? ` (use ${heading} for the heading and ${body} for the body line if available, otherwise approximate)`
        : heading
          ? ` (use ${heading} if available, otherwise approximate)`
          : body
            ? ` (use ${body} if available, otherwise approximate)`
            : '';
    lines.push(
      `Typography section: render the word "${sample}" in the typographic style described as "${kit.typography.mood}"${fontHint}. Include a one-line note describing that style.`,
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

  if (kit?.logo && kit.logo.markType !== 'none') {
    const tagline = kit.logo.hasTagline ? ' (with a small tagline)' : '';
    const note = `${kit.logo.markType} — ${kit.logo.description}${tagline}`;
    lines.push(`Logo / mark note (small text in a corner): "${truncate(note, 120)}".`);
  }

  lines.push(
    'Overall aesthetic: minimal, designerly, like a Behance brand-guidelines page. Use the brand palette colors as the dominant color story. Do not include any people, logos, or brand marks other than the title text.',
  );

  return lines.join(' ');
}

/**
 * Reference-aware brand-board prompt. Mirrors `buildBrandBoardPrompt` but
 * tailored for the multi-image `images.edit` call: the model sees the
 * brand's actual profile picture as reference 1 and 0-N representative posts
 * as references 2..(1+postCount), and we anchor the logo + visual-style strip
 * to those references positionally.
 *
 * The prompt explicitly forbids reproducing identifiable subjects from the
 * post references — we want their *style* (color temperature, framing,
 * lighting) reflected in the moodboard, not their *content* literally
 * collaged in.
 */
export function buildBrandBoardPromptWithRefs(brand: Brand, postCount: number): string {
  const handle = brand.igHandle ?? 'brand';
  const kit = brand.brandKitJson;
  const ds = brand.designSystemJson;
  const voice = brand.voiceJson;
  const totalRefs = 1 + postCount;

  const lines: string[] = [];

  lines.push(
    `You will receive ${totalRefs} reference image${totalRefs === 1 ? '' : 's'}. Reference 1 is the brand's actual Instagram profile picture / avatar.${
      postCount > 0
        ? ` Reference${postCount === 1 ? '' : 's'} 2${postCount > 1 ? `-${1 + postCount}` : ''} ${postCount === 1 ? 'is' : 'are'} representative post${postCount === 1 ? '' : 's'} from the brand's feed.`
        : ''
    }`,
  );
  lines.push(
    'A clean, editorial brand moodboard / brand-board layout — single 1024x1024 square image, magazine-style composition with generous whitespace and organized sections.',
  );
  lines.push(`Centered title across the top: "@${handle} — Brand Board".`);

  if (kit?.logo && kit.logo.markType !== 'none') {
    lines.push(
      "Place the brand's actual mark — taken from reference 1 — in the top-right corner of the board at small size. Preserve the exact mark colors, weight, and proportions; do not redraw, restyle, or simplify the logo. If reference 1 is a portrait/photo with no logo, omit this corner element entirely.",
    );
  } else {
    lines.push(
      'Reference 1 contains no recognizable logo (it is a portrait or photo). Do not place any mark in the corners of the board.',
    );
  }

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
    const heading = kit.typography.headingFont;
    const body = kit.typography.bodyFont;
    const fontHint =
      heading && body && heading.toLowerCase() !== body.toLowerCase()
        ? ` (use ${heading} for the heading and ${body} for the body line if available, otherwise approximate)`
        : heading
          ? ` (use ${heading} if available, otherwise approximate)`
          : body
            ? ` (use ${body} if available, otherwise approximate)`
            : '';
    lines.push(
      `Typography section: render the word "${sample}" in the typographic style described as "${kit.typography.mood}"${fontHint}. Include a one-line note describing that style.`,
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

  if (postCount > 0) {
    const styleClause = visualBits.length
      ? ` This strip should also reflect ${visualBits.join('; ')}.`
      : '';
    lines.push(
      `Visual style strip: a small abstracted scene whose color temperature, lighting, framing, and post-processing match the post reference${postCount === 1 ? '' : 's'} (references 2${postCount > 1 ? `-${1 + postCount}` : ''}). Do NOT reproduce identifiable people, faces, or specific scenes from those references — interpret their style, do not copy their content.${styleClause}`,
    );
  } else if (visualBits.length) {
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

  lines.push(
    'Overall aesthetic: minimal, designerly, like a Behance brand-guidelines page. Use the brand palette as the dominant color story. The only logo on the board is the small mark in the corner taken from reference 1; do not invent or add any other marks. Do not include identifiable people from the reference photos.',
  );

  return lines.join(' ');
}

/**
 * Pick which IG assets to send to gpt-image-2 as references for the brand
 * board. Profile picture is always position 1 (anchor for the logo); top 2
 * posts by engagement (likes + comments) follow as visual-style anchors.
 *
 * We read URLs from the persisted brand state — `brandKitJson.logo.profilePicUrl`
 * (set by the profile-pic analyzer during onboarding) with a fallback to
 * `igAnalysisJson.profile.profilePicUrl`, and `igAnalysisJson.posts` for the
 * post images.
 */
export function selectBrandBoardReferences(brand: Brand): {
  profilePicUrl: string | null;
  postUrls: string[];
} {
  const profilePicUrl =
    brand.brandKitJson?.logo?.profilePicUrl ??
    brand.igAnalysisJson?.profile?.profilePicUrl ??
    null;

  const posts = brand.igAnalysisJson?.posts ?? [];
  const postUrls = [...posts]
    .sort((a, b) => engagement(b) - engagement(a))
    .slice(0, 2)
    .map((p) => p.imageUrl)
    .filter((u): u is string => Boolean(u));

  return { profilePicUrl, postUrls };
}

function engagement(p: { likes?: number; comments?: number }): number {
  return (p.likes ?? 0) + (p.comments ?? 0);
}

/**
 * Short caption sent on WhatsApp alongside the brand-board image. Purely
 * descriptive — the actual review question (lock in / tweak / try a different
 * handle) is the next message (`REVIEW_PROMPT`). Keeping the caption neutral
 * avoids two back-to-back asks that read as redundant.
 */
export function buildBrandBoardCaption(brand: Brand): string {
  const handle = brand.igHandle ?? 'your brand';
  return `Here's how I'm reading @${handle}.`;
}

/**
 * Generate the brand-board image for `brand`, upload to R2, persist the
 * resulting URL on the brand row, and return it.
 *
 * Primary path: `images.edit` with the brand's profile picture + top 2 posts
 * by engagement as reference images, so the actual logo gets composited into
 * the corner and the visual-style strip is anchored to the brand's real feed.
 *
 * Fallback path (text-only `images.generate`): used when no profile pic URL
 * is available on the brand or when the profile-pic download fails. The post
 * downloads are best-effort — if they fail we still proceed with whatever
 * profile-pic-only references we have.
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

  const log = logger.child({ brandId: brand.id });
  const { profilePicUrl, postUrls } = selectBrandBoardReferences(brand);

  const refs: ReferenceImage[] = [];
  if (profilePicUrl) {
    try {
      const img = await downloadImage(profilePicUrl);
      refs.push({ bytes: img.bytes, mediaType: img.mediaType, label: 'profile-pic' });
    } catch (err) {
      log.warn({ err, profilePicUrl }, 'Brand board: profile-pic download failed');
    }

    // Post downloads are best-effort and run in parallel. Drop any failures.
    if (postUrls.length > 0) {
      const fetched = await Promise.all(
        postUrls.map(async (url, i) => {
          try {
            return await downloadImage(url);
          } catch (err) {
            log.warn({ err, url, idx: i }, 'Brand board: post-ref download failed; skipping');
            return null;
          }
        }),
      );
      fetched.forEach((img, i) => {
        if (img) refs.push({ bytes: img.bytes, mediaType: img.mediaType, label: `post-${i + 1}` });
      });
    }
  }

  let prompt: string;
  let mode: 'edit-with-refs' | 'generate-text-only';
  if (refs.length > 0 && refs[0]?.label === 'profile-pic') {
    const postRefCount = refs.length - 1;
    prompt = buildBrandBoardPromptWithRefs(brand, postRefCount);
    mode = 'edit-with-refs';
  } else {
    prompt = buildBrandBoardPrompt(brand);
    mode = 'generate-text-only';
  }

  log.info({ mode, refCount: refs.length }, 'Generating brand board image');

  const { url } = await generateAndStoreImage({
    prompt,
    size: '1024x1024',
    quality: 'medium',
    ownerId: brand.id,
    ...(mode === 'edit-with-refs' ? { referenceImages: refs } : {}),
  });

  await updateBrand(brand.id, { brandBoardImageUrl: url });

  return { url, reused: false };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
