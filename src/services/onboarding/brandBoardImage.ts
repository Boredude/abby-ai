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
 * the brand's profile pic and/or top posts as references. We only fall back
 * to this text-only prompt when EVERY reference download failed.
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
    lines.push(typographySection(handle, kit.typography));
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
 * Reference-aware brand-board prompt for the multi-image `images.edit` call.
 * The reference layout adapts to whichever downloads succeeded:
 *
 *  - profile-pic + posts → reference 1 = profile pic (corner-logo anchor),
 *    references 2..(1+postCount) = post style anchors.
 *  - profile-pic only → reference 1 = profile pic (corner-logo anchor), no
 *    visual-style strip refs.
 *  - posts only → references 1..postCount = post style anchors; the corner
 *    logo gets rendered from the persisted text description instead of a
 *    reference image.
 *  - neither → caller should use the text-only `buildBrandBoardPrompt`.
 *
 * The prompt explicitly forbids reproducing identifiable subjects from the
 * post references — we want their *style* (color temperature, framing,
 * lighting) reflected in the moodboard, not their *content* literally
 * collaged in.
 */
export function buildBrandBoardPromptWithRefs(
  brand: Brand,
  layout: { hasProfilePic: boolean; postCount: number },
): string {
  const handle = brand.igHandle ?? 'brand';
  const kit = brand.brandKitJson;
  const ds = brand.designSystemJson;
  const voice = brand.voiceJson;
  const { hasProfilePic, postCount } = layout;
  const totalRefs = (hasProfilePic ? 1 : 0) + postCount;

  // Reference-index helpers so the prompt copy stays in lock-step with the
  // actual file order we'll send to gpt-image-2 in `generateBrandBoard`.
  const profilePicRef = hasProfilePic ? 1 : null;
  const postRefStart = hasProfilePic ? 2 : 1;
  const postRefEnd = postRefStart + postCount - 1;
  const postRefRange =
    postCount === 0
      ? null
      : postCount === 1
        ? `${postRefStart}`
        : `${postRefStart}-${postRefEnd}`;

  const lines: string[] = [];

  // Opening: tell the model exactly what each reference is.
  const intro: string[] = [
    `You will receive ${totalRefs} reference image${totalRefs === 1 ? '' : 's'}.`,
  ];
  if (profilePicRef) {
    intro.push(`Reference ${profilePicRef} is the brand's actual Instagram profile picture / avatar.`);
  }
  if (postRefRange) {
    const subj = postCount === 1 ? 'is a representative post' : 'are representative posts';
    intro.push(`Reference${postCount === 1 ? '' : 's'} ${postRefRange} ${subj} from the brand's feed.`);
  }
  lines.push(intro.join(' '));

  lines.push(
    'A clean, editorial brand moodboard / brand-board layout — single 1024x1024 square image, magazine-style composition with generous whitespace and organized sections.',
  );
  lines.push(`Centered title across the top: "@${handle} — Brand Board".`);

  // Logo handling — three branches:
  //   1. profile-pic available + brand has a real mark → composite it from
  //      reference 1 into the corner.
  //   2. profile-pic available + no logo (markType: 'none') → don't fabricate
  //      a logo.
  //   3. profile-pic missing but we have a logo description → render the
  //      mark from the persisted text description instead of a reference.
  const hasMark = !!(kit?.logo && kit.logo.markType !== 'none');
  if (hasProfilePic && hasMark) {
    lines.push(
      `Place the brand's actual mark — taken from reference ${profilePicRef} — in the top-right corner of the board at small size. Preserve the exact mark colors, weight, and proportions; do not redraw, restyle, or simplify the logo. If reference ${profilePicRef} is a portrait/photo with no logo, omit this corner element entirely.`,
    );
  } else if (hasProfilePic && !hasMark) {
    lines.push(
      `Reference ${profilePicRef} contains no recognizable logo (it is a portrait or photo). Do not place any mark in the corners of the board.`,
    );
  } else if (!hasProfilePic && hasMark && kit?.logo) {
    const tagline = kit.logo.hasTagline ? ' (with a small tagline)' : '';
    const note = `${kit.logo.markType} — ${kit.logo.description}${tagline}`;
    lines.push(
      `Logo / mark note (small text in the top-right corner): "${truncate(note, 120)}". Render this as descriptive text, not as a reproduced logo, since the actual mark is not provided.`,
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
    lines.push(typographySection(handle, kit.typography));
  }

  const visualBits: string[] = [];
  if (ds?.photoStyle) visualBits.push(`photo style: ${ds.photoStyle}`);
  if (ds?.illustrationStyle) visualBits.push(`illustration style: ${ds.illustrationStyle}`);
  if (ds?.lighting) visualBits.push(`lighting: ${ds.lighting}`);
  if (ds?.composition) visualBits.push(`composition: ${ds.composition}`);
  if (ds?.recurringMotifs?.length) {
    visualBits.push(`recurring motifs: ${ds.recurringMotifs.slice(0, 3).join(', ')}`);
  }

  if (postRefRange) {
    const styleClause = visualBits.length
      ? ` This strip should also reflect ${visualBits.join('; ')}.`
      : '';
    lines.push(
      `Visual style strip: a small abstracted scene whose color temperature, lighting, framing, and post-processing match the post reference${postCount === 1 ? '' : 's'} (reference${postCount === 1 ? '' : 's'} ${postRefRange}). Do NOT reproduce identifiable people, faces, or specific scenes from those references — interpret their style, do not copy their content.${styleClause}`,
    );
  } else if (visualBits.length) {
    lines.push(
      `Imagery / visual style strip: a small representative scene reflecting ${visualBits.join('; ')}.`,
    );
  }

  if (voice?.tone?.length) {
    lines.push(`Voice tag row: small chips / tags reading: ${voice.tone.slice(0, 4).join(', ')}.`);
  }
  if (voice?.audience) {
    lines.push(`Caption under the voice tags: "Audience: ${truncate(voice.audience, 100)}".`);
  }

  // Closing aesthetic line — adjust the "only logo on the board" guard
  // depending on whether we anchored the corner mark on a reference.
  const closingMarkClause = hasProfilePic && hasMark
    ? `The only logo on the board is the small mark in the corner taken from reference ${profilePicRef}; do not invent or add any other marks.`
    : 'Do not invent or add any logos other than what was explicitly described above.';
  const peopleClause = postRefRange ? ' Do not include identifiable people from the reference photos.' : '';
  lines.push(
    `Overall aesthetic: minimal, designerly, like a Behance brand-guidelines page. Use the brand palette as the dominant color story. ${closingMarkClause}${peopleClause}`,
  );

  return lines.join(' ');
}

/**
 * Build the typography section text in a way that matches the reconciled
 * `BrandKit['typography']`. When the synthesizer marked the typography as
 * website-sourced we trust the mood string verbatim and only surface the
 * actual font names — no contradictory "elegant serif" mood-then-fonts mash.
 *
 * When typography came from the IG analyzer we keep the existing behavior:
 * the IG-mood is the anchor and any guessed fonts ride along as a
 * parenthetical hint.
 */
function typographySection(
  handle: string,
  typography: NonNullable<Brand['brandKitJson']>['typography'],
): string {
  const sample = typography.sample?.trim() || `@${handle}`;
  if (typography.source === 'website') {
    const headingClause = typography.headingFont
      ? ` Render the title in ${typography.headingFont}; if not available, use a visually-faithful substitute (do NOT substitute with a script / handwritten font).`
      : '';
    const bodyClause = typography.bodyFont
      ? ` Use ${typography.bodyFont} for the descriptive line below.`
      : '';
    return `Typography section: render the word "${sample}" as the typography sample. ${typography.mood}${headingClause}${bodyClause} Include a one-line note that names the font(s) used.`;
  }
  // Instagram-only path (or unknown source): keep the legacy mood-led copy
  // because we have no real fonts to anchor on.
  const heading = typography.headingFont;
  const body = typography.bodyFont;
  const fontHint =
    heading && body && heading.toLowerCase() !== body.toLowerCase()
      ? ` (use ${heading} for the heading and ${body} for the body line if available, otherwise approximate)`
      : heading
        ? ` (use ${heading} if available, otherwise approximate)`
        : body
          ? ` (use ${body} if available, otherwise approximate)`
          : '';
  return `Typography section: render the word "${sample}" in the typographic style described as "${typography.mood}"${fontHint}. Include a one-line note describing that style.`;
}

/**
 * Pick which IG assets to send to gpt-image-2 as references for the brand
 * board. Profile picture (when available) anchors the logo corner; top 2
 * posts by engagement (likes + comments) anchor the visual-style strip.
 *
 * We read URLs from the persisted brand state — `brandKitJson.logo.profilePicUrl`
 * (set by the profile-pic analyzer during onboarding, R2-mirrored when
 * possible) with a fallback to `igAnalysisJson.profile.profilePicUrl`, and
 * `igAnalysisJson.posts` for the post images.
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
 * Reference layout adapts to whichever downloads succeeded so a single
 * failed asset doesn't poison the whole refs path:
 *
 *  - profile-pic + posts → `images.edit` with `[profilePic, ...posts]` and
 *    a corner-logo-from-reference-1 prompt.
 *  - profile-pic only → `images.edit` with `[profilePic]` and the same
 *    corner-logo prompt.
 *  - posts only → `images.edit` with `[...posts]` and a text-described-mark
 *    prompt (no corner-logo from reference).
 *  - neither → text-only `images.generate` fallback.
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

  // Best-effort downloads. We keep profilePic + post downloads independent
  // so a single failure doesn't poison the whole refs path.
  let profilePicRef: ReferenceImage | null = null;
  if (profilePicUrl) {
    try {
      const img = await downloadImage(profilePicUrl);
      profilePicRef = { bytes: img.bytes, mediaType: img.mediaType, label: 'profile-pic' };
    } catch (err) {
      log.warn({ err, profilePicUrl }, 'Brand board: profile-pic download failed');
    }
  }

  const postRefs: ReferenceImage[] = [];
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
      if (img) postRefs.push({ bytes: img.bytes, mediaType: img.mediaType, label: `post-${i + 1}` });
    });
  }

  // Order matters: if the profile pic survived, it MUST be reference 1 so
  // the prompt's "reference 1 = profile pic" anchor lines up with what
  // gpt-image-2 actually receives.
  const refs: ReferenceImage[] = [
    ...(profilePicRef ? [profilePicRef] : []),
    ...postRefs,
  ];

  let prompt: string;
  let mode: 'edit-with-refs' | 'generate-text-only';
  if (refs.length > 0) {
    prompt = buildBrandBoardPromptWithRefs(brand, {
      hasProfilePic: !!profilePicRef,
      postCount: postRefs.length,
    });
    mode = 'edit-with-refs';
  } else {
    prompt = buildBrandBoardPrompt(brand);
    mode = 'generate-text-only';
  }

  log.info(
    {
      mode,
      refCount: refs.length,
      hasProfilePic: !!profilePicRef,
      postRefCount: postRefs.length,
    },
    'Generating brand board image',
  );

  const { url } = await generateAndStoreImage({
    prompt,
    size: '1024x1024',
    quality: 'medium',
    ownerId: brand.id,
    ...(brand.igHandle ? { ownerSlug: brand.igHandle } : {}),
    kind: 'brand-board',
    ...(mode === 'edit-with-refs' ? { referenceImages: refs } : {}),
  });

  await updateBrand(brand.id, { brandBoardImageUrl: url });

  return { url, reused: false };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
