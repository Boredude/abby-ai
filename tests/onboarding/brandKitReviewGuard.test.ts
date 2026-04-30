import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand } from '../../src/db/schema.js';
import type {
  OnboardingStepContext,
  OnboardingStepResult,
} from '../../src/mastra/onboarding/types.js';
import { makeMockBoundChannel } from '../helpers/mockChannel.js';

// Hoisted module mocks. Everything brandKit.ts imports that touches network,
// LLMs, or the DB has to be a pass-through here so executeBrandKit reaches
// the review-loop path deterministically.
const mocks = vi.hoisted(() => ({
  classifyReviewIntent: vi.fn(),
  findBrandById: vi.fn(),
  updateBrand: vi.fn(),
  generateMock: vi.fn(),
  getDuffyAgent: vi.fn(() => ({ generate: mocks.generateMock })),
  phraseAsDuffy: vi.fn(async (params: { fallback: string }) => params.fallback),
  presentSpy: vi.fn(),
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

vi.mock('../../src/mastra/agents/voice.js', () => ({
  phraseAsDuffy: mocks.phraseAsDuffy,
}));

// Heavy onboarding dependencies — never reached on the review-loop path,
// stubbed so the import graph resolves without pulling in real LLM clients.
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

const BRAND_ID = '11111111-1111-1111-1111-111111111111';

function fakeReviewedBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: BRAND_ID,
    igHandle: 'ob.cocktails',
    voiceJson: { tone: ['playful'] },
    cadenceJson: null,
    brandKitJson: { palette: [{ hex: '#ffffff' }], typography: { mood: 'classic' } },
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

function makeCtx(reply: string, brand = fakeReviewedBrand()): OnboardingStepContext {
  return {
    brandId: BRAND_ID,
    brand,
    channel: makeMockBoundChannel(),
    resumeData: { reply },
    suspend: ((reason) => {
      throw new Error(`unexpected suspend: ${JSON.stringify(reason)}`);
    }) as OnboardingStepContext['suspend'],
  };
}

async function run(ctx: OnboardingStepContext): Promise<OnboardingStepResult> {
  return brandKitStep.execute(ctx);
}

describe('brandKitStep review-loop guard', () => {
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

  it('returns done when the classifier returns approve', async () => {
    mocks.classifyReviewIntent.mockResolvedValueOnce({ intent: 'approve' });
    const result = await run(makeCtx('Yess!!'));
    expect(result).toEqual({ status: 'done' });
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it('upgrades edit-with-approval-shaped-editSummary to approve (does not call Duffy)', async () => {
    mocks.classifyReviewIntent.mockResolvedValueOnce({
      intent: 'edit',
      editSummary: 'yes',
    });
    const result = await run(makeCtx('Yess!!'));
    expect(result).toEqual({ status: 'done' });
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it.each(['lock it in', 'YES', '👍', 'perfect'])(
    'upgrades edit with editSummary=%s to approve',
    async (editSummary) => {
      mocks.classifyReviewIntent.mockResolvedValueOnce({
        intent: 'edit',
        editSummary,
      });
      const result = await run(makeCtx('emphatic reply'));
      expect(result).toEqual({ status: 'done' });
      expect(mocks.generateMock).not.toHaveBeenCalled();
    },
  );

  it('hands real edits to Duffy as before (editSummary is a genuine tweak)', async () => {
    mocks.classifyReviewIntent.mockResolvedValueOnce({
      intent: 'edit',
      editSummary: 'swap green for navy',
    });
    mocks.generateMock.mockResolvedValueOnce({ text: "Got it — I'll switch the green for navy." });

    // The edit branch ends with presentBrandKitToUser → suspend; we don't
    // care about the suspend, only that Duffy was invoked with the tweak.
    const ctx = makeCtx('change the green to navy');
    let suspended: unknown = null;
    ctx.suspend = ((reason) => {
      suspended = reason;
      throw new Error('SUSPEND');
    }) as OnboardingStepContext['suspend'];

    await expect(run(ctx)).rejects.toThrow('SUSPEND');
    expect(mocks.generateMock).toHaveBeenCalledTimes(1);
    expect(suspended).toMatchObject({ question: 'brand_kit_review' });
  });
});
