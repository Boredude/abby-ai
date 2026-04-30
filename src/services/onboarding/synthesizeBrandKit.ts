import type {
  BrandDesignSystem,
  BrandKit,
  BrandLogo,
  BrandVoice,
  IgAnalysisSnapshot,
} from '../../db/schema.js';
import type { InstagramScrapeResult } from '../apify/instagramScraper.js';
import type { ProfilePicAnalysis } from './analyzeProfilePic.js';
import type { VisualAnalysis } from './analyzeVisuals.js';
import type { VoiceAnalysis } from './analyzeVoice.js';
import type { WebsiteAnalysis } from './analyzeWebsite.js';
import type { MirroredImage } from './igImageMirror.js';

/**
 * Stitch the raw scrape + analyzer outputs into the persisted brand shapes.
 * Pure function — no I/O — so it's easy to unit-test.
 */

export type SynthesizeInput = {
  scrape: InstagramScrapeResult;
  profilePic: ProfilePicAnalysis;
  visuals: VisualAnalysis;
  voice: VoiceAnalysis;
  website?: WebsiteAnalysis;
  /**
   * Optional pre-reconciled typography object. When present we trust it
   * verbatim; when absent we derive a deterministic typography description
   * from the website + IG signals. Lets `analyzeBrand` plug an LLM-based
   * reconciler in front of synthesizeBrandKit without making this module
   * impure.
   */
  typography?: BrandKit['typography'];
  /**
   * Map from original IG CDN URL → R2-mirrored copy. When provided we
   * replace IG URLs with R2 URLs everywhere we persist them (snapshot,
   * logo.profilePicUrl, post imageUrls), so the brand row stops depending
   * on Instagram's time-limited tokens for downstream re-fetches.
   */
  mirroredUrls?: Map<string, MirroredImage>;
};

export type SynthesizedBrand = {
  brandKit: BrandKit;
  designSystem: BrandDesignSystem;
  voice: BrandVoice;
  igAnalysis: IgAnalysisSnapshot;
};

export function synthesizeBrandKit(input: SynthesizeInput): SynthesizedBrand {
  const { scrape, profilePic, visuals, voice, website, mirroredUrls } = input;

  const stableUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    return mirroredUrls?.get(url)?.url ?? url;
  };

  const rawProfilePicUrl =
    scrape.profile.profilePicUrlHD ?? scrape.profile.profilePicUrl;
  const profilePicUrl = stableUrl(rawProfilePicUrl);

  const logo: BrandLogo = {
    markType: profilePic.logo.markType,
    description: profilePic.logo.description,
    colors: profilePic.logo.colors,
    hasTagline: profilePic.logo.hasTagline,
    ...(profilePicUrl ? { profilePicUrl } : {}),
  };

  const typography = input.typography ?? buildTypography(visuals, website);

  const brandKit: BrandKit = {
    palette: profilePic.palette.map((p) => ({
      hex: p.hex,
      role: p.role,
      ...(p.name ? { name: p.name } : {}),
    })),
    typography,
    logo,
  };

  const designSystem: BrandDesignSystem = {
    photoStyle: visuals.photoStyle,
    illustrationStyle: visuals.illustrationStyle,
    composition: visuals.composition,
    lighting: visuals.lighting,
    recurringMotifs: visuals.recurringMotifs,
    doVisuals: visuals.doVisuals,
    dontVisuals: visuals.dontVisuals,
  };

  const persistedVoice: BrandVoice = {
    summary: voice.summary,
    tone: voice.tone,
    audience: voice.audience,
    do: voice.do,
    dont: voice.dont,
    hashtags: voice.hashtags,
    themes: voice.themes,
    emojiUsage: voice.emojiUsage,
    hashtagPolicy: voice.hashtagPolicy,
  };

  const igAnalysis: IgAnalysisSnapshot = {
    capturedAt: new Date().toISOString(),
    handle: scrape.profile.username,
    profile: {
      ...(scrape.profile.fullName !== undefined ? { fullName: scrape.profile.fullName } : {}),
      ...(scrape.profile.biography !== undefined ? { biography: scrape.profile.biography } : {}),
      ...(scrape.profile.followersCount !== undefined
        ? { followers: scrape.profile.followersCount }
        : {}),
      ...(scrape.profile.followsCount !== undefined
        ? { following: scrape.profile.followsCount }
        : {}),
      ...(scrape.profile.postsCount !== undefined
        ? { postsCount: scrape.profile.postsCount }
        : {}),
      ...(profilePicUrl !== undefined ? { profilePicUrl } : {}),
      ...(scrape.profile.isVerified !== undefined
        ? { isVerified: scrape.profile.isVerified }
        : {}),
      ...(website?.resolvedUrl
        ? { externalUrl: website.resolvedUrl }
        : scrape.profile.externalUrl !== undefined
          ? { externalUrl: scrape.profile.externalUrl }
          : {}),
    },
    posts: scrape.posts.map((p) => ({
      url: p.url,
      imageUrl: stableUrl(p.imageUrl) ?? p.imageUrl,
      caption: p.caption,
      ...(p.likesCount !== undefined ? { likes: p.likesCount } : {}),
      ...(p.commentsCount !== undefined ? { comments: p.commentsCount } : {}),
      ...(p.timestamp !== undefined ? { timestamp: p.timestamp } : {}),
      ...(p.type !== undefined
        ? { type: mapPostType(p.type) }
        : {}),
    })),
    rawVisuals: visuals,
    rawVoice: voice,
    rawProfilePic: profilePic,
    ...(website ? { rawWebsite: website } : {}),
  };

  return { brandKit, designSystem, voice: persistedVoice, igAnalysis };
}

/**
 * Deterministic typography fallback. Used when the LLM reconciler upstream
 * returned nothing (or wasn't called). Two principles:
 *
 *  1. When the website analyzer succeeded, the website's actual fonts are
 *     the source of truth for typography — they're the only signal in our
 *     pipeline grounded in real CSS rather than vibes-from-photos. We mark
 *     `source: 'website'` and emit a font-aware mood string that doesn't
 *     reference the IG-derived typographyMood at all (which often
 *     contradicts the actual website type system, e.g. florals + script vs.
 *     clean geometric sans).
 *
 *  2. When there's no website signal, fall back to the IG-derived
 *     typographyMood — that's still the best guess we have for "how does
 *     the brand's type *feel*", even though it's inferred from photo
 *     content rather than declared CSS.
 */
function buildTypography(
  visuals: VisualAnalysis,
  website: WebsiteAnalysis | undefined,
): BrandKit['typography'] {
  const baseMood = visuals.typographyMood;
  if (!website) {
    return { mood: baseMood, source: 'instagram' };
  }

  const fontFamilies = website.fontFamilies.length > 0 ? website.fontFamilies : undefined;
  const headingFont = website.headingFont ?? fontFamilies?.[0];
  const bodyFont =
    website.bodyFont ?? (fontFamilies && fontFamilies.length > 1 ? fontFamilies[1] : undefined);

  const hasAnyFontInfo = Boolean(headingFont || bodyFont || fontFamilies?.length);
  if (!hasAnyFontInfo) {
    // Website analyzer succeeded but found no fonts (rare — SPA / image-only
    // homepage). Treat as IG-only.
    return { mood: baseMood, source: 'instagram' };
  }

  // Website is authoritative. Build a mood string that *only* references the
  // actual fonts. The IG-derived typographyMood is intentionally dropped
  // here — keeping it would re-introduce the contradiction (e.g. the IG
  // grid says "elegant serif with script italics" but the website CSS uses
  // Lexend Deca + Inter). The IG mood is still preserved on
  // `igAnalysis.rawVisuals.typographyMood` for debugging and future use.
  const mood = describeFontPair(headingFont, bodyFont, fontFamilies);

  return {
    mood,
    source: 'website',
    ...(headingFont ? { headingFont } : {}),
    ...(bodyFont ? { bodyFont } : {}),
    ...(fontFamilies ? { fontFamilies } : {}),
  };
}

function describeFontPair(
  heading: string | undefined,
  body: string | undefined,
  families: string[] | undefined,
): string {
  if (heading && body && heading.toLowerCase() !== body.toLowerCase()) {
    return `Brand type system from the live site: ${heading} for headings, ${body} for body. Render the typography sample using these exact fonts (or visually-faithful substitutes).`;
  }
  if (heading) {
    return `Brand type system from the live site: ${heading}. Render the typography sample in this font (or a visually-faithful substitute).`;
  }
  if (body) {
    return `Brand type system from the live site: ${body}. Render the typography sample in this font (or a visually-faithful substitute).`;
  }
  const list = (families ?? []).slice(0, 2).join(' / ');
  return list
    ? `Brand type system from the live site: ${list}.`
    : 'Brand type system from the live site (font names unavailable).';
}

function mapPostType(t: string): IgAnalysisSnapshot['posts'][number]['type'] {
  const lower = t.toLowerCase();
  if (lower === 'video' || lower === 'reel' || lower === 'clips') return 'reel';
  if (lower === 'sidecar') return 'sidecar';
  if (lower === 'image') return 'image';
  return 'image';
}

// Re-export for unit testing. `buildTypography` is the deterministic fallback
// used when the LLM reconciler upstream is disabled or fails.
export { buildTypography as _buildTypographyForTests };
