import { describe, expect, it } from 'vitest';
import { synthesizeBrandKit } from '../../src/services/onboarding/synthesizeBrandKit.js';
import type { InstagramScrapeResult } from '../../src/services/apify/instagramScraper.js';
import type { VisualAnalysis } from '../../src/services/onboarding/analyzeVisuals.js';
import type { VoiceAnalysis } from '../../src/services/onboarding/analyzeVoice.js';

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

const visuals: VisualAnalysis = {
  palette: [
    { hex: '#1a1a1a', role: 'primary', name: 'soft black' },
    { hex: '#f5f0e6', role: 'background', name: 'warm sand' },
    { hex: '#c64f3a', role: 'accent', name: 'sun-faded brick' },
  ],
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
    const out = synthesizeBrandKit({ scrape, visuals, voice });

    expect(out.brandKit.palette).toHaveLength(3);
    expect(out.brandKit.palette[0]).toMatchObject({ hex: '#1a1a1a', role: 'primary' });
    expect(out.brandKit.typography.mood).toContain('serif');

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
    expect(typeof out.igAnalysis.capturedAt).toBe('string');
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

    const out = synthesizeBrandKit({ scrape: minimalScrape, visuals, voice });

    expect(out.igAnalysis.handle).toBe('minimal');
    expect(out.igAnalysis.profile.followers).toBeUndefined();
    expect(out.igAnalysis.profile.profilePicUrl).toBeUndefined();
  });
});
