import { describe, expect, it, vi } from 'vitest';

vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

const mocks = vi.hoisted(() => ({
  setStepArtifact: vi.fn(async (_id: string, _input: unknown) => ({
    contentTypeId: 'igSinglePost',
    steps: {},
    editHistory: [],
  })),
  requireBrandContext: vi.fn(async (brandId: string) => ({
    brand: {
      id: brandId,
      igHandle: 'cocktailshq',
      timezone: 'UTC',
      voiceJson: {
        summary: 'Bright, modern, sensory.',
        tone: ['warm', 'confident'],
        audience: 'Tel-Aviv cocktail lovers',
        do: ['use vivid imagery'],
        dont: ['use generic copy'],
        emojiUsage: 'sparing',
        hashtags: ['cocktailshq'],
        hashtagPolicy: '3-5 niche',
      },
      brandKitJson: { palette: [{ hex: '#c75b8a', role: 'primary' }] },
      designSystemJson: { photoStyle: 'editorial', composition: 'tight crops' },
    },
    channels: [],
    primaryChannel: null,
    channelByKind: () => null,
  })),
  generateAndStoreImage: vi.fn(async (opts: { prompt: string; size?: string }) => ({
    url: 'https://cdn.example.com/img.png',
    key: `images/cocktailshq/draft-${Date.now()}.png`,
    prompt: opts.prompt,
  })),
  ideatorGenerate: vi.fn(),
  copywriterGenerate: vi.fn(),
  hashtaggerGenerate: vi.fn(),
  stylistGenerate: vi.fn(),
}));

vi.mock('../../src/db/repositories/draftGenerations.js', () => ({
  setStepArtifact: mocks.setStepArtifact,
}));
vi.mock('../../src/context/BrandContext.js', () => ({
  requireBrandContext: mocks.requireBrandContext,
}));
vi.mock('../../src/services/media/generateImage.js', () => ({
  generateAndStoreImage: mocks.generateAndStoreImage,
}));
vi.mock('../../src/mastra/agents/ideator.js', () => ({
  getIdeatorAgent: () => ({ id: 'ideatorAgent', generate: mocks.ideatorGenerate }),
}));
vi.mock('../../src/mastra/agents/copywriter.js', () => ({
  getCopywriterAgent: () => ({ id: 'copywriterAgent', generate: mocks.copywriterGenerate }),
}));
vi.mock('../../src/mastra/agents/hashtagger.js', () => ({
  getHashtaggerAgent: () => ({ id: 'hashtaggerAgent', generate: mocks.hashtaggerGenerate }),
}));
vi.mock('../../src/mastra/agents/stylist.js', () => ({
  getStylistAgent: () => ({ id: 'stylistAgent', generate: mocks.stylistGenerate }),
}));

import { runCreativeStep } from '../../src/services/creative/runCreativeStep.js';

const draftId = 'draft-1';
const brandId = 'brand-1';

describe('runCreativeStep', () => {
  it('ideation: invokes ideator with structured output and persists the artifact', async () => {
    mocks.ideatorGenerate.mockResolvedValueOnce({
      object: {
        topic: 'Summer launch',
        angle: 'a top-down pour shot of the new matcha spritz at golden hour',
        themes: ['seasonal', 'green'],
        rationale: 'Aligns with the brand kit and recent feed',
      },
    });

    const result = await runCreativeStep({
      draftId,
      brandId,
      stepId: 'ideation',
      briefingHint: 'lean into the new menu',
      artifacts: {},
    });

    expect(mocks.ideatorGenerate).toHaveBeenCalledTimes(1);
    const opts = mocks.ideatorGenerate.mock.calls[0]?.[1] as { structuredOutput?: unknown };
    expect(opts?.structuredOutput).toBeDefined();
    expect(result.stepId).toBe('ideation');
    expect(mocks.setStepArtifact).toHaveBeenCalledWith(draftId, {
      step: 'ideation',
      artifact: expect.objectContaining({ topic: 'Summer launch' }),
    });
  });

  it('copy: requires the ideation dependency and forwards it to the copywriter', async () => {
    mocks.copywriterGenerate.mockResolvedValueOnce({
      object: {
        hook: 'Summer in a glass.',
        body: 'Body line one.\n\nBody line two.',
        cta: 'Tap to order.',
        fullCaption:
          'Summer in a glass.\n\nBody line one.\n\nBody line two.\n\nTap to order. (long enough to satisfy schema)',
      },
    });

    await runCreativeStep({
      draftId,
      brandId,
      stepId: 'copy',
      artifacts: {
        ideation: {
          topic: 't',
          angle: 'a long enough angle',
          themes: [],
          rationale: 'r',
        },
      },
    });

    const prompt = mocks.copywriterGenerate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('a long enough angle');
    expect(mocks.setStepArtifact).toHaveBeenLastCalledWith(draftId, {
      step: 'copy',
      artifact: expect.objectContaining({ hook: 'Summer in a glass.' }),
    });
  });

  it('copy: throws cleanly when ideation is missing', async () => {
    await expect(
      runCreativeStep({ draftId, brandId, stepId: 'copy', artifacts: {} }),
    ).rejects.toThrow(/dependency 'ideation' not found/);
    expect(mocks.copywriterGenerate).not.toHaveBeenCalledTimes(2); // unchanged from prior test
  });

  it('image: skips the LLM and forwards the stylist prompt to the renderer', async () => {
    mocks.generateAndStoreImage.mockClear();
    mocks.setStepArtifact.mockClear();
    await runCreativeStep({
      draftId,
      brandId,
      stepId: 'image',
      artifacts: {
        ideation: { topic: 't', angle: 'a long enough angle', themes: [], rationale: 'r' },
        artDirection: {
          subject: 's',
          composition: 'c',
          lighting: 'l',
          palette: ['#fff'],
          mood: 'm',
          imagePrompt: 'a vivid 30-word prompt the image renderer should consume.',
          size: '1024x1536',
        },
      },
    });

    expect(mocks.generateAndStoreImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'a vivid 30-word prompt the image renderer should consume.',
        size: '1024x1536',
        ownerId: brandId,
        ownerSlug: 'cocktailshq',
        kind: 'draft',
      }),
    );
    const lastCall = mocks.setStepArtifact.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({
      step: 'image',
      artifact: { url: 'https://cdn.example.com/img.png' },
    });
  });

  it('throws when an agent returns no structured object', async () => {
    mocks.ideatorGenerate.mockResolvedValueOnce({ text: 'I forgot to use the schema' });
    await expect(
      runCreativeStep({ draftId, brandId, stepId: 'ideation', artifacts: {} }),
    ).rejects.toThrow(/returned no structured output/);
  });
});
