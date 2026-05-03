import { describe, expect, it, vi } from 'vitest';
import type { PostDraftGeneration } from '../../src/services/creative/types.js';

vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

const mocks = vi.hoisted(() => ({
  createPostDraft: vi.fn(async (input: unknown) => {
    const i = input as { brandId: string };
    return {
      id: 'draft-new',
      brandId: i.brandId,
      caption: '',
      mediaUrls: [] as string[],
      status: 'draft',
    };
  }),
  findDraftById: vi.fn(async (id: string) => ({
    id,
    brandId: 'brand-1',
    caption: '',
    mediaUrls: [] as string[],
    status: 'draft',
  })),
  updateDraftStatus: vi.fn(
    async (id: string, status: string, _patch: unknown = {}) => ({ id, status }),
  ),
  initGeneration: vi.fn(async (_id: string, _opts: unknown) => ({
    contentTypeId: 'igSinglePost',
    steps: {},
    editHistory: [],
  })),
  getGeneration: vi.fn(async (_id: string): Promise<PostDraftGeneration | null> => {
    // Simulate a complete run.
    return {
      contentTypeId: 'igSinglePost',
      steps: {
        ideation: {
          topic: 'summer',
          angle: 'a properly long angle',
          themes: [],
          rationale: 'r',
        },
        copy: {
          hook: 'Hook.',
          body: 'Body.',
          cta: 'CTA.',
          fullCaption: 'Hook.\n\nBody.\n\nCTA. (long enough to pass schema)',
        },
        hashtags: { hashtags: ['one', '#two'] },
        artDirection: {
          subject: 's',
          composition: 'c',
          lighting: 'l',
          palette: ['#fff'],
          mood: 'm',
          imagePrompt: 'a vivid thirty-word prompt for the image generator to render.',
          size: '1024x1536',
        },
        image: { url: 'https://cdn.example.com/x.png', key: 'k', prompt: 'p' },
      },
      editHistory: [],
    };
  }),
  invalidateSteps: vi.fn(async (_id: string, _args: unknown) => ({
    contentTypeId: 'igSinglePost',
    steps: {},
    editHistory: [],
  })),
  directorGenerate: vi.fn(async (_prompt: string, _opts: unknown) => ({ text: 'done' })),
}));

vi.mock('../../src/db/repositories/postDrafts.js', () => ({
  createPostDraft: mocks.createPostDraft,
  findDraftById: mocks.findDraftById,
  updateDraftStatus: mocks.updateDraftStatus,
}));
vi.mock('../../src/db/repositories/draftGenerations.js', () => ({
  initGeneration: mocks.initGeneration,
  getGeneration: mocks.getGeneration,
  invalidateSteps: mocks.invalidateSteps,
}));
vi.mock('../../src/mastra/agents/creativeDirector.js', () => ({
  getCreativeDirectorAgent: () => ({ generate: mocks.directorGenerate }),
}));

import { runCreativePipeline } from '../../src/services/creative/runCreativePipeline.js';

describe('runCreativePipeline', () => {
  it('creates a new draft, initialises generation, invokes director, assembles output', async () => {
    const result = await runCreativePipeline({
      brandId: 'brand-1',
      contentTypeId: 'igSinglePost',
      briefingHint: 'summer drinks',
    });

    expect(mocks.createPostDraft).toHaveBeenCalledOnce();
    expect(mocks.initGeneration).toHaveBeenCalledWith('draft-new', {
      contentTypeId: 'igSinglePost',
      reset: true,
    });
    expect(mocks.directorGenerate).toHaveBeenCalledOnce();
    // Final caption includes the hashtag block.
    expect(result.caption).toContain('#one #two');
    expect(result.mediaUrls).toEqual(['https://cdn.example.com/x.png']);
    expect(result.imageUrl).toBe('https://cdn.example.com/x.png');
    // The final write-back stamps caption + mediaUrls on the draft row.
    const lastCall = mocks.updateDraftStatus.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('draft-new');
    expect(lastCall?.[1]).toBe('draft');
  });

  it('on rerun with editDirective: skips reset, invalidates the requested steps', async () => {
    mocks.createPostDraft.mockClear();
    mocks.initGeneration.mockClear();
    mocks.invalidateSteps.mockClear();

    await runCreativePipeline({
      brandId: 'brand-1',
      contentTypeId: 'igSinglePost',
      existingDraftId: 'draft-existing',
      editDirective: { note: 'new photo please', invalidate: ['image'] },
    });

    expect(mocks.createPostDraft).not.toHaveBeenCalled();
    expect(mocks.initGeneration).toHaveBeenCalledWith('draft-existing', {
      contentTypeId: 'igSinglePost',
      reset: false,
    });
    // image has no downstream in the igSinglePost DAG, so the expanded list
    // is just ['image'].
    expect(mocks.invalidateSteps).toHaveBeenCalledWith('draft-existing', {
      steps: ['image'],
      note: 'new photo please',
    });
  });

  it('on rerun with copy invalidation: cascades to hashtags', async () => {
    mocks.invalidateSteps.mockClear();
    await runCreativePipeline({
      brandId: 'brand-1',
      contentTypeId: 'igSinglePost',
      existingDraftId: 'draft-existing',
      editDirective: { note: 'tighter copy', invalidate: ['copy'] },
    });
    const call = mocks.invalidateSteps.mock.calls.at(-1);
    expect(call?.[1]).toEqual({
      steps: ['copy', 'hashtags'],
      note: 'tighter copy',
    });
  });

  it('throws loudly when the director ends with a missing artifact', async () => {
    mocks.getGeneration.mockResolvedValueOnce({
      contentTypeId: 'igSinglePost',
      steps: {
        ideation: {
          topic: 't',
          angle: 'long enough angle',
          themes: [],
          rationale: 'r',
        },
        // copy is missing → pipeline failure.
      },
      editHistory: [],
    });
    await expect(
      runCreativePipeline({
        brandId: 'brand-1',
        contentTypeId: 'igSinglePost',
      }),
    ).rejects.toThrow(/did not produce all required artifacts/);
  });
});
