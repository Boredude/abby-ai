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
};

export type SynthesizedBrand = {
  brandKit: BrandKit;
  designSystem: BrandDesignSystem;
  voice: BrandVoice;
  igAnalysis: IgAnalysisSnapshot;
};

export function synthesizeBrandKit(input: SynthesizeInput): SynthesizedBrand {
  const { scrape, profilePic, visuals, voice, website } = input;

  const profilePicUrl = scrape.profile.profilePicUrlHD ?? scrape.profile.profilePicUrl;

  const logo: BrandLogo = {
    markType: profilePic.logo.markType,
    description: profilePic.logo.description,
    colors: profilePic.logo.colors,
    hasTagline: profilePic.logo.hasTagline,
    ...(profilePicUrl ? { profilePicUrl } : {}),
  };

  const typography = buildTypography(visuals, website);

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
      ...(scrape.profile.profilePicUrlHD !== undefined
        ? { profilePicUrl: scrape.profile.profilePicUrlHD }
        : scrape.profile.profilePicUrl !== undefined
          ? { profilePicUrl: scrape.profile.profilePicUrl }
          : {}),
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
      imageUrl: p.imageUrl,
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
 * Combine the post-grid mood string (always present) with whatever font
 * names we managed to scrape from the brand's website (when available).
 * The `mood` string stays human-readable for image-generation prompts; the
 * structured fields give the rest of the system real font names to work with.
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
  const bodyFont = website.bodyFont ?? (fontFamilies && fontFamilies.length > 1 ? fontFamilies[1] : undefined);

  const fontHint = formatFontHint(headingFont, bodyFont, fontFamilies);
  const mood = fontHint ? `${baseMood} — primary type: ${fontHint}` : baseMood;
  const hasAnyFontInfo = Boolean(headingFont || bodyFont || fontFamilies?.length);
  const source: NonNullable<BrandKit['typography']['source']> = hasAnyFontInfo
    ? 'mixed'
    : 'instagram';

  return {
    mood,
    source,
    ...(headingFont ? { headingFont } : {}),
    ...(bodyFont ? { bodyFont } : {}),
    ...(fontFamilies ? { fontFamilies } : {}),
  };
}

function formatFontHint(
  heading: string | undefined,
  body: string | undefined,
  families: string[] | undefined,
): string | null {
  if (heading && body && heading.toLowerCase() !== body.toLowerCase()) {
    return `${heading} (heading) / ${body} (body)`;
  }
  if (heading) return `${heading} (heading)`;
  if (body) return `${body} (body)`;
  if (families && families.length > 0) {
    return families.slice(0, 2).join(' / ');
  }
  return null;
}

function mapPostType(t: string): IgAnalysisSnapshot['posts'][number]['type'] {
  const lower = t.toLowerCase();
  if (lower === 'video' || lower === 'reel' || lower === 'clips') return 'reel';
  if (lower === 'sidecar') return 'sidecar';
  if (lower === 'image') return 'image';
  return 'image';
}
