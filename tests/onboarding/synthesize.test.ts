import { describe, expect, it } from 'vitest';
import {
  synthesizeBrandKit,
  _buildTypographyForTests as buildTypography,
} from '../../src/services/onboarding/synthesizeBrandKit.js';
import type { InstagramScrapeResult } from '../../src/services/apify/instagramScraper.js';
import type { ProfilePicAnalysis } from '../../src/services/onboarding/analyzeProfilePic.js';
import type { VisualAnalysis } from '../../src/services/onboarding/analyzeVisuals.js';
import type { VoiceAnalysis } from '../../src/services/onboarding/analyzeVoice.js';
import type { WebsiteAnalysis } from '../../src/services/onboarding/analyzeWebsite.js';
import type { MirroredImage } from '../../src/services/onboarding/igImageMirror.js';

const scrape: InstagramScrapeResult = {
  profile: {
    username: 'humansofny',
    url: 'https://www.instagram.com/humansofny',
    fullName: 'Humans of New York',
    biography: 'New York City, one story at a time.',
    followersCount: 12_700_000,
    followsCount: 712,
    postsCount: 5851,
    profilePicUrl: 'https://example.com/p.jpg',
    profilePicUrlHD: 'https://example.com/p_hd.jpg',
    isVerified: true,
    externalUrl: 'https://bit.ly/4tX4uZt',
  },
  posts: [
    {
      id: 'p1',
      type: 'Sidecar',
      shortCode: 'abc',
      url: 'https://www.instagram.com/p/abc/',
      caption: 'Some caption',
      imageUrl: 'https://example.com/i1.jpg',
      images: ['https://example.com/i1.jpg', 'https://example.com/i1b.jpg'],
      likesCount: 1000,
      commentsCount: 30,
      timestamp: '2025-10-13T14:14:46.000Z',
    },
    {
      id: 'p2',
      type: 'Video',
      shortCode: 'def',
      url: 'https://www.instagram.com/p/def/',
      caption: 'Other caption',
      imageUrl: 'https://example.com/i2.jpg',
      images: ['https://example.com/i2.jpg'],
      likesCount: 500,
      commentsCount: 10,
    },
  ],
};

const profilePic: ProfilePicAnalysis = {
  palette: [
    { hex: '#1a1a1a', role: 'primary', name: 'soft black' },
    { hex: '#f5f0e6', role: 'background', name: 'warm sand' },
    { hex: '#c64f3a', role: 'accent', name: 'sun-faded brick' },
  ],
  logo: {
    markType: 'wordmark',
    description: 'Sans-serif "HONY" wordmark in cream on a charcoal square.',
    colors: ['#1a1a1a', '#f5f0e6'],
    hasTagline: false,
  },
};

const visuals: VisualAnalysis = {
  typographyMood: 'A grounded, classic serif paired with quiet captions.',
  photoStyle: 'Documentary portraits, candid eye contact, natural light.',
  illustrationStyle: 'No illustrations — purely photographic.',
  composition: 'Subject-centered, shallow depth, NYC streetscape backdrops.',
  lighting: 'Golden hour and overcast diffuse — warm and humane.',
  recurringMotifs: ['portraits', 'street life', 'gestures'],
  doVisuals: ['Center the subject', 'Use natural light'],
  dontVisuals: ['Use heavy filters', 'Crop tightly'],
};

const voice: VoiceAnalysis = {
  summary: 'A warm, story-first voice rooted in single-subject portrait narratives.',
  tone: ['warm', 'observational', 'humane'],
  audience: 'Curious New Yorkers and global followers who value human stories.',
  do: ['Lead with the subject', 'Quote the person directly'],
  dont: ['Talk about the brand', 'Use marketing copy'],
  themes: ['family', 'resilience', 'NYC'],
  emojiUsage: 'sparing',
  hashtagPolicy: 'Avoid hashtags; let the story carry the post.',
  hashtags: [],
};

describe('synthesizeBrandKit', () => {
  it('produces brand kit, design system, voice, and snapshot', () => {
    const out = synthesizeBrandKit({ scrape, profilePic, visuals, voice });

    expect(out.brandKit.palette).toHaveLength(3);
    expect(out.brandKit.palette[0]).toMatchObject({ hex: '#1a1a1a', role: 'primary' });
    // No website signal → typography falls back to the IG mood.
    expect(out.brandKit.typography.mood).toContain('serif');
    expect(out.brandKit.logo).toMatchObject({
      markType: 'wordmark',
      description: profilePic.logo.description,
      hasTagline: false,
      profilePicUrl: 'https://example.com/p_hd.jpg',
    });

    expect(out.designSystem.photoStyle).toMatch(/Documentary/);
    expect(out.designSystem.recurringMotifs).toContain('portraits');

    expect(out.voice.summary).toBe(voice.summary);
    expect(out.voice.tone).toEqual(voice.tone);
    expect(out.voice.themes).toEqual(voice.themes);
    expect(out.voice.emojiUsage).toBe('sparing');
    expect(out.voice.hashtagPolicy).toBe(voice.hashtagPolicy);

    expect(out.igAnalysis.handle).toBe('humansofny');
    expect(out.igAnalysis.profile.followers).toBe(12_700_000);
    expect(out.igAnalysis.profile.profilePicUrl).toBe('https://example.com/p_hd.jpg');
    expect(out.igAnalysis.posts).toHaveLength(2);
    expect(out.igAnalysis.posts[0]?.url).toBe('https://www.instagram.com/p/abc/');
    expect(out.igAnalysis.posts[1]?.type).toBe('reel');
    expect(out.igAnalysis.rawVisuals).toEqual(visuals);
    expect(out.igAnalysis.rawVoice).toEqual(voice);
    expect(out.igAnalysis.rawProfilePic).toEqual(profilePic);
    expect(typeof out.igAnalysis.capturedAt).toBe('string');
  });

  it('falls back to instagram-only typography when no website is provided', () => {
    const out = synthesizeBrandKit({ scrape, profilePic, visuals, voice });
    expect(out.brandKit.typography.source).toBe('instagram');
    expect(out.brandKit.typography.headingFont).toBeUndefined();
    expect(out.brandKit.typography.bodyFont).toBeUndefined();
    expect(out.brandKit.typography.fontFamilies).toBeUndefined();
    expect(out.igAnalysis.rawWebsite).toBeUndefined();
    expect(out.igAnalysis.profile.externalUrl).toBe('https://bit.ly/4tX4uZt');
  });

  it('treats website as authoritative for typography and drops the contradictory IG mood', () => {
    const website: WebsiteAnalysis = {
      ok: true,
      sourceUrl: 'humansofny.com',
      resolvedUrl: 'https://www.humansofny.com/',
      fontFamilies: ['Source Serif Pro', 'Inter', 'Helvetica Neue'],
      headingFont: 'Source Serif Pro',
      bodyFont: 'Inter',
      googleFonts: ['Source Serif Pro', 'Inter'],
      pageTitle: 'Humans of New York',
    };

    const out = synthesizeBrandKit({ scrape, profilePic, visuals, voice, website });

    expect(out.brandKit.typography.source).toBe('website');
    expect(out.brandKit.typography.headingFont).toBe('Source Serif Pro');
    expect(out.brandKit.typography.bodyFont).toBe('Inter');
    expect(out.brandKit.typography.fontFamilies).toEqual([
      'Source Serif Pro',
      'Inter',
      'Helvetica Neue',
    ]);
    expect(out.brandKit.typography.mood).toContain('Source Serif Pro');
    expect(out.brandKit.typography.mood).toContain('Inter');
    // The IG mood ("classic serif paired with quiet captions") must NOT
    // bleed into the typography mood when website fonts override it.
    expect(out.brandKit.typography.mood).not.toContain(visuals.typographyMood);
    expect(out.igAnalysis.rawWebsite).toEqual(website);
    expect(out.igAnalysis.profile.externalUrl).toBe('https://www.humansofny.com/');
    // The IG-derived mood is still preserved on the raw snapshot for
    // debugging and future use.
    expect(out.igAnalysis.rawVisuals).toEqual(visuals);
  });

  it('uses an upstream-reconciled typography object verbatim when provided', () => {
    const reconciled = {
      mood: 'Custom reconciled description from the LLM step.',
      source: 'website' as const,
      headingFont: 'Reconciled Heading',
      bodyFont: 'Reconciled Body',
      fontFamilies: ['Reconciled Heading', 'Reconciled Body'],
    };
    const website: WebsiteAnalysis = {
      ok: true,
      sourceUrl: 'humansofny.com',
      resolvedUrl: 'https://www.humansofny.com/',
      fontFamilies: ['Reconciled Heading', 'Reconciled Body'],
      headingFont: 'Reconciled Heading',
      bodyFont: 'Reconciled Body',
      googleFonts: [],
      pageTitle: 'Humans of New York',
    };
    const out = synthesizeBrandKit({
      scrape,
      profilePic,
      visuals,
      voice,
      website,
      typography: reconciled,
    });
    expect(out.brandKit.typography).toEqual(reconciled);
  });

  it('replaces IG URLs with R2-mirrored URLs everywhere we persist them', () => {
    const mirroredUrls = new Map<string, MirroredImage>([
      [
        'https://example.com/p_hd.jpg',
        {
          originalUrl: 'https://example.com/p_hd.jpg',
          url: 'https://r2.example/profile-pic.jpg',
          key: 'ig-mirror/x/profile-pic-aaa.jpg',
          mediaType: 'image/jpeg',
        },
      ],
      [
        'https://example.com/i1.jpg',
        {
          originalUrl: 'https://example.com/i1.jpg',
          url: 'https://r2.example/post-1.jpg',
          key: 'ig-mirror/x/post-1-bbb.jpg',
          mediaType: 'image/jpeg',
        },
      ],
    ]);

    const out = synthesizeBrandKit({ scrape, profilePic, visuals, voice, mirroredUrls });
    expect(out.brandKit.logo?.profilePicUrl).toBe('https://r2.example/profile-pic.jpg');
    expect(out.igAnalysis.profile.profilePicUrl).toBe('https://r2.example/profile-pic.jpg');
    expect(out.igAnalysis.posts[0]?.imageUrl).toBe('https://r2.example/post-1.jpg');
    // Post 2 was not mirrored — the original IG URL survives.
    expect(out.igAnalysis.posts[1]?.imageUrl).toBe('https://example.com/i2.jpg');
  });

  it('omits optional profile fields that are undefined', () => {
    const minimalScrape: InstagramScrapeResult = {
      profile: {
        username: 'minimal',
        url: 'https://www.instagram.com/minimal',
      },
      posts: [
        {
          id: 'x',
          type: 'Image',
          shortCode: 'x',
          url: 'https://www.instagram.com/p/x/',
          caption: '',
          imageUrl: 'https://example.com/x.jpg',
          images: ['https://example.com/x.jpg'],
        },
      ],
    };

    const out = synthesizeBrandKit({ scrape: minimalScrape, profilePic, visuals, voice });

    expect(out.igAnalysis.handle).toBe('minimal');
    expect(out.igAnalysis.profile.followers).toBeUndefined();
    expect(out.igAnalysis.profile.profilePicUrl).toBeUndefined();
    expect(out.brandKit.logo?.profilePicUrl).toBeUndefined();
  });
});

describe('buildTypography (deterministic fallback)', () => {
  it('falls back to the IG mood when the website analyzer found no fonts', () => {
    const website: WebsiteAnalysis = {
      ok: true,
      sourceUrl: 'spa.example',
      resolvedUrl: 'https://spa.example/',
      fontFamilies: [],
      googleFonts: [],
    };
    const t = buildTypography(visuals, website);
    expect(t.source).toBe('instagram');
    expect(t.mood).toBe(visuals.typographyMood);
    expect(t.headingFont).toBeUndefined();
    expect(t.bodyFont).toBeUndefined();
  });

  it('describes a single-font website with a non-script-friendly hint', () => {
    const website: WebsiteAnalysis = {
      ok: true,
      sourceUrl: 'mono.example',
      resolvedUrl: 'https://mono.example/',
      fontFamilies: ['Inter'],
      headingFont: 'Inter',
      googleFonts: ['Inter'],
    };
    const t = buildTypography(visuals, website);
    expect(t.source).toBe('website');
    expect(t.headingFont).toBe('Inter');
    expect(t.mood).toContain('Inter');
    expect(t.mood).not.toContain(visuals.typographyMood);
  });
});
