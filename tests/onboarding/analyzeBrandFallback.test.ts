import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const defaultEnv: Record<string, unknown> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    IG_GRID_CAPTURE_ENABLED: true,
  };
  const loadEnv = vi.fn(() => defaultEnv);
  return {
    loadEnv,
    defaultEnv,
    fetchInstagramProfile: vi.fn(),
    captureInstagramGrid: vi.fn(),
    analyzeInstagramVisuals: vi.fn(),
    analyzeInstagramVoice: vi.fn(),
    updateBrand: vi.fn(),
  };
});

vi.mock('../../src/config/env.js', () => ({
  loadEnv: mocks.loadEnv,
  env: new Proxy({}, { get: (_t, p: string) => mocks.loadEnv()[p] }),
}));

vi.mock('../../src/services/apify/instagramScraper.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/apify/instagramScraper.js')
  >('../../src/services/apify/instagramScraper.js');
  return {
    ...actual,
    fetchInstagramProfile: mocks.fetchInstagramProfile,
  };
});

vi.mock('../../src/services/instagram/captureGrid.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/instagram/captureGrid.js')
  >('../../src/services/instagram/captureGrid.js');
  return {
    ...actual,
    captureInstagramGrid: mocks.captureInstagramGrid,
  };
});

vi.mock('../../src/services/onboarding/analyzeVisuals.js', () => ({
  analyzeInstagramVisuals: mocks.analyzeInstagramVisuals,
}));

vi.mock('../../src/services/onboarding/analyzeVoice.js', () => ({
  analyzeInstagramVoice: mocks.analyzeInstagramVoice,
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  updateBrand: mocks.updateBrand,
}));

import { analyzeBrand } from '../../src/services/onboarding/analyzeBrand.js';
import { IgGridCaptureError } from '../../src/services/instagram/captureGrid.js';

const baseScrape = {
  profile: {
    username: 'humansofny',
    url: 'https://www.instagram.com/humansofny',
  },
  posts: [
    {
      id: 'p1',
      type: 'Image',
      shortCode: 'a',
      url: 'https://www.instagram.com/p/a/',
      caption: 'caption a',
      imageUrl: 'https://cdn.example/a.jpg',
      images: ['https://cdn.example/a.jpg'],
    },
  ],
};

const baseVisuals = {
  palette: [{ hex: '#000000', role: 'primary' as const }],
  typographyMood: 'mood',
  photoStyle: 'photo',
  illustrationStyle: '',
  composition: 'comp',
  lighting: 'light',
  recurringMotifs: [],
  doVisuals: ['do'],
  dontVisuals: ['dont'],
};

const baseVoice = {
  summary: 'summary',
  tone: ['warm'],
  audience: 'aud',
  do: ['do'],
  dont: ['dont'],
  themes: [],
  emojiUsage: 'sparing' as const,
  hashtagPolicy: '',
  hashtags: [],
};

beforeEach(() => {
  mocks.defaultEnv.IG_GRID_CAPTURE_ENABLED = true;
  mocks.fetchInstagramProfile.mockReset().mockResolvedValue(baseScrape);
  mocks.captureInstagramGrid.mockReset();
  mocks.analyzeInstagramVisuals.mockReset().mockResolvedValue(baseVisuals);
  mocks.analyzeInstagramVoice.mockReset().mockResolvedValue(baseVoice);
  mocks.updateBrand.mockReset().mockResolvedValue({ id: 'brand-1' });
});

describe('analyzeBrand — fallback when grid capture fails', () => {
  it('falls back to Apify post images when captureInstagramGrid throws IgGridCaptureError', async () => {
    mocks.captureInstagramGrid.mockRejectedValue(
      new IgGridCaptureError('timeout', 'IG grid capture timed out'),
    );

    const result = await analyzeBrand({ brandId: 'brand-1', handle: 'humansofny' });

    expect(result.ok).toBe(true);

    const visualsCall = mocks.analyzeInstagramVisuals.mock.calls[0]?.[0];
    expect(visualsCall).toMatchObject({
      source: 'posts',
      imageUrls: ['https://cdn.example/a.jpg'],
    });

    const updateCall = mocks.updateBrand.mock.calls[0]?.[1];
    expect(updateCall.igAnalysisJson.gridCapture).toBeUndefined();
  });

  it('skips capture entirely when the feature flag is off', async () => {
    mocks.defaultEnv.IG_GRID_CAPTURE_ENABLED = false;

    const result = await analyzeBrand({ brandId: 'brand-1', handle: 'humansofny' });

    expect(result.ok).toBe(true);
    expect(mocks.captureInstagramGrid).not.toHaveBeenCalled();
    expect(mocks.analyzeInstagramVisuals.mock.calls[0]?.[0].source).toBe('posts');
  });
});
