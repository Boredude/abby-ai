import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand } from '../../src/db/schema.js';
import type { OnboardingStepContext } from '../../src/mastra/onboarding/types.js';
import { makeMockBoundChannel } from '../helpers/mockChannel.js';

// Hoisted module mocks so the brandKit import graph resolves without
// pulling in real LLM clients, schemas, or DB connections.
const mocks = vi.hoisted(() => ({
  classifyReviewIntent: vi.fn(),
  findBrandById: vi.fn(),
  updateBrand: vi.fn(),
  generateMock: vi.fn(),
  getDuffyAgent: vi.fn(),
  phraseAsDuffy: vi.fn(),
}));

vi.mock('../../src/services/onboarding/classifyReviewIntent.js', () => ({
  classifyReviewIntent: mocks.classifyReviewIntent,
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  findBrandById: mocks.findBrandById,
  updateBrand: mocks.updateBrand,
}));

vi.mock('../../src/mastra/agents/duffy.js', () => ({
  getDuffyAgent: mocks.getDuffyAgent,
}));

vi.mock('../../src/mastra/agents/voice.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    phraseAsDuffy: mocks.phraseAsDuffy,
  };
});

vi.mock('../../src/services/onboarding/analyzeBrand.js', () => ({
  analyzeBrand: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../src/services/onboarding/analyzeWebsite.js', () => ({
  normalizeWebsiteUrl: vi.fn((url: string) => url),
}));
vi.mock('../../src/services/onboarding/brandBoardImage.js', () => ({
  buildBrandBoardCaption: vi.fn(() => 'caption'),
  generateBrandBoard: vi.fn(async () => ({ url: 'https://example.com/board.png' })),
}));
vi.mock('../../src/services/onboarding/extractHandle.js', () => ({
  extractHandleWithLLM: vi.fn(async () => null),
}));
vi.mock('../../src/services/apify/instagramScraper.js', () => ({
  fetchInstagramProfile: vi.fn(),
  InstagramScraperError: class extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
}));
vi.mock('../../src/mastra/memory.js', () => ({
  memoryFor: vi.fn(() => ({ thread: 'fake' })),
}));

import { brandKitStep } from '../../src/mastra/onboarding/steps/brandKit.js';
import type { MockBoundChannel } from '../helpers/mockChannel.js';

const BRAND_ID = '11111111-1111-1111-1111-111111111111';

function fakeReviewedBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: BRAND_ID,
    igHandle: 'ob.cocktails',
    voiceJson: { tone: ['playful'] },
    cadenceJson: null,
    brandKitJson: { palette: [{ hex: '#fff' }], typography: { mood: 'classic' } },
    designSystemJson: null,
    igAnalysisJson: null,
    brandBoardImageUrl: 'https://example.com/board.png',
    timezone: 'UTC',
    status: 'onboarding',
    awaitingWebsiteReply: false,
    websiteUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Brand;
}

function makeCtx(reply: string, channel: MockBoundChannel): OnboardingStepContext {
  return {
    brandId: BRAND_ID,
    brand: fakeReviewedBrand(),
    channel,
    resumeData: { reply },
    suspend: ((_reason) => {
      throw new Error('SUSPEND');
    }) as OnboardingStepContext['suspend'],
  };
}

describe('brandKitStep edit branch — voice-leak guard', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof (m as unknown as { mockReset?: () => void }).mockReset === 'function') {
        (m as unknown as { mockReset: () => void }).mockReset();
      }
    });
    mocks.findBrandById.mockResolvedValue(fakeReviewedBrand());
    mocks.updateBrand.mockResolvedValue(undefined);
    mocks.phraseAsDuffy.mockImplementation(
      async (params: { fallback: string }) => params.fallback,
    );
    mocks.getDuffyAgent.mockReturnValue({ generate: mocks.generateMock });
  });

  it('forwards a clean Duffy reply to the channel verbatim', async () => {
    mocks.classifyReviewIntent.mockResolvedValueOnce({
      intent: 'edit',
      editSummary: 'more playful tone',
    });
    const cleanReply = "Sweet — I'll lean more playful on the next pass.";
    mocks.generateMock.mockResolvedValueOnce({ text: cleanReply });

    const channel = makeMockBoundChannel();
    await expect(brandKitStep.execute(makeCtx('more playful', channel))).rejects.toThrow(
      'SUSPEND',
    );

    const sendTextCalls = channel.sendText.mock.calls.map((c) => c[0]);
    expect(sendTextCalls).toContain(cleanReply);
    // phraseAsDuffy is still used elsewhere in the flow (presentBrandKit
    // re-render after the edit), but the leak fallback specifically should
    // NOT have fired.
    const fallbackCalls = mocks.phraseAsDuffy.mock.calls.filter((c) => {
      const arg = c[0] as { goal?: string };
      return arg?.goal?.startsWith("Acknowledge the user's requested tweak");
    });
    expect(fallbackCalls).toHaveLength(0);
  });

  it.each([
    "I need to get the current brand context first to see what we're working with, then understand what \"Yess!!\" means in context. Without a concrete tweak mentioned, I can't map this to voice/cadence/timezone.",
    'Let me check what they meant before replying.',
    'Calling updateBrandContext to apply the change.',
    '[brandId=11111111-1111-1111-1111-111111111111] noted the tweak.',
  ])('suppresses leaked Duffy reply and falls back to phraseAsDuffy: %s', async (leaked) => {
    mocks.classifyReviewIntent.mockResolvedValueOnce({
      intent: 'edit',
      editSummary: 'more playful tone',
    });
    mocks.generateMock.mockResolvedValueOnce({ text: leaked });

    const channel = makeMockBoundChannel();
    await expect(brandKitStep.execute(makeCtx('more playful', channel))).rejects.toThrow(
      'SUSPEND',
    );

    const sendTextCalls = channel.sendText.mock.calls.map((c) => c[0]);
    // Leaked text MUST NOT have reached the channel.
    expect(sendTextCalls).not.toContain(leaked);
    // The fallback phraseAsDuffy goal must have been invoked.
    const fallbackCalls = mocks.phraseAsDuffy.mock.calls.filter((c) => {
      const arg = c[0] as { goal?: string };
      return arg?.goal?.startsWith("Acknowledge the user's requested tweak");
    });
    expect(fallbackCalls.length).toBeGreaterThan(0);
  });

  it('falls back gracefully when Duffy throws', async () => {
    mocks.classifyReviewIntent.mockResolvedValueOnce({
      intent: 'edit',
      editSummary: 'swap green for navy',
    });
    mocks.generateMock.mockRejectedValueOnce(new Error('rate limited'));

    const channel = makeMockBoundChannel();
    await expect(brandKitStep.execute(makeCtx('swap green for navy', channel))).rejects.toThrow(
      'SUSPEND',
    );

    const fallbackCalls = mocks.phraseAsDuffy.mock.calls.filter((c) => {
      const arg = c[0] as { goal?: string };
      return arg?.goal?.startsWith("Acknowledge the user's requested tweak");
    });
    expect(fallbackCalls.length).toBeGreaterThan(0);
  });
});
