import type {
  BrandDesignSystem,
  BrandKit,
  BrandVoice,
  IgAnalysisSnapshot,
} from '../../db/schema.js';
import type { InstagramScrapeResult } from '../apify/instagramScraper.js';
import type { VisualAnalysis } from './analyzeVisuals.js';
import type { VoiceAnalysis } from './analyzeVoice.js';

/**
 * Stitch the raw scrape + analyzer outputs into the persisted brand shapes.
 * Pure function — no I/O — so it's easy to unit-test.
 */

export type SynthesizeInput = {
  scrape: InstagramScrapeResult;
  visuals: VisualAnalysis;
  voice: VoiceAnalysis;
  /**
   * Optional Playwright grid-capture metadata. Pass-through into the
   * `igAnalysis` snapshot for traceability of which image set the visual
   * analyzer consumed.
   */
  gridCapture?: NonNullable<IgAnalysisSnapshot['gridCapture']>;
};

export type SynthesizedBrand = {
  brandKit: BrandKit;
  designSystem: BrandDesignSystem;
  voice: BrandVoice;
  igAnalysis: IgAnalysisSnapshot;
};

export function synthesizeBrandKit(input: SynthesizeInput): SynthesizedBrand {
  const { scrape, visuals, voice, gridCapture } = input;

  const brandKit: BrandKit = {
    palette: visuals.palette.map((p) => ({
      hex: p.hex,
      role: p.role,
      ...(p.name ? { name: p.name } : {}),
    })),
    typography: { mood: visuals.typographyMood },
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
      ...(scrape.profile.externalUrl !== undefined
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
    ...(gridCapture ? { gridCapture } : {}),
  };

  return { brandKit, designSystem, voice: persistedVoice, igAnalysis };
}

function mapPostType(t: string): IgAnalysisSnapshot['posts'][number]['type'] {
  const lower = t.toLowerCase();
  if (lower === 'video' || lower === 'reel' || lower === 'clips') return 'reel';
  if (lower === 'sidecar') return 'sidecar';
  if (lower === 'image') return 'image';
  return 'image';
}
