import { describe, expect, it, vi } from 'vitest';
import type { PostDraftGeneration, StepId } from '../../src/services/creative/types.js';

vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

const FULL_GENERATION: PostDraftGeneration = {
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
    steps: {} as Record<string, unknown>,
    editHistory: [] as unknown[],
  })),
  // Driven by the test: each call increments how many steps are "complete"
  // so the pipeline loop both (a) sees the right artifacts when it asks and
  // (b) eventually returns the fully-populated generation for assembly.
  getGeneration: vi.fn(),
  invalidateSteps: vi.fn(async (_id: string, _args: unknown) => ({
    contentTypeId: 'igSinglePost',
    steps: {},
    editHistory: [],
  })),
  runCreativeStep: vi.fn(async (_input: { stepId: StepId }) => ({
    stepId: _input.stepId,
    artifact: {} as unknown,
  })),
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
vi.mock('../../src/services/creative/runCreativeStep.js', () => ({
  runCreativeStep: mocks.runCreativeStep,
}));

import { runCreativePipeline } from '../../src/services/creative/runCreativePipeline.js';

describe('runCreativePipeline', () => {
  it('creates a new draft, initialises generation, runs every missing step in order, assembles output', async () => {
    mocks.runCreativeStep.mockClear();
    mocks.getGeneration.mockReset();
    // Pipeline polls getGeneration once per step (5 steps) plus one final
    // poll for assembly. First 5 polls return empty steps so each step is
    // dispatched; the 6th returns the fully populated generation.
    mocks.getGeneration
      .mockResolvedValueOnce({ contentTypeId: 'igSinglePost', steps: {}, editHistory: [] })
      .mockResolvedValueOnce({ contentTypeId: 'igSinglePost', steps: {}, editHistory: [] })
      .mockResolvedValueOnce({ contentTypeId: 'igSinglePost', steps: {}, editHistory: [] })
      .mockResolvedValueOnce({ contentTypeId: 'igSinglePost', steps: {}, editHistory: [] })
      .mockResolvedValueOnce({ contentTypeId: 'igSinglePost', steps: {}, editHistory: [] })
      .mockResolvedValueOnce(FULL_GENERATION);

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
    // Every pipeline step was dispatched, in DAG order.
    const dispatchedSteps = mocks.runCreativeStep.mock.calls.map((c) => c[0].stepId);
    expect(dispatchedSteps).toEqual([
      'ideation',
      'copy',
      'hashtags',
      'artDirection',
      'image',
    ]);
    // Final caption includes the hashtag block from the assembled generation.
    expect(result.caption).toContain('#one #two');
    expect(result.mediaUrls).toEqual(['https://cdn.example.com/x.png']);
    expect(result.imageUrl).toBe('https://cdn.example.com/x.png');
    // Final write-back stamps caption + mediaUrls on the draft row.
    const lastCall = mocks.updateDraftStatus.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('draft-new');
    expect(lastCall?.[1]).toBe('draft');
  });

  it('on rerun with editDirective: skips reset, invalidates the requested steps, only re-runs invalidated ones', async () => {
    mocks.createPostDraft.mockClear();
    mocks.initGeneration.mockClear();
    mocks.invalidateSteps.mockClear();
    mocks.runCreativeStep.mockClear();
    mocks.getGeneration.mockReset();

    // After invalidation: ideation/copy/artDirection/image already done,
    // only hashtags is missing. The pipeline should poll and dispatch only
    // the missing step, then assemble.
    const partial: PostDraftGeneration = {
      contentTypeId: 'igSinglePost',
      steps: {
        ideation: FULL_GENERATION.steps.ideation,
        copy: FULL_GENERATION.steps.copy,
        artDirection: FULL_GENERATION.steps.artDirection,
        image: FULL_GENERATION.steps.image,
      },
      editHistory: [{ at: 'now', note: 'new tags', invalidated: ['hashtags'] }],
    };
    mocks.getGeneration
      .mockResolvedValueOnce(partial) // ideation poll → already done
      .mockResolvedValueOnce(partial) // copy poll → already done
      .mockResolvedValueOnce(partial) // hashtags poll → missing → dispatch
      .mockResolvedValueOnce(partial) // artDirection poll → already done
      .mockResolvedValueOnce(partial) // image poll → already done
      .mockResolvedValueOnce(FULL_GENERATION); // assembly poll

    await runCreativePipeline({
      brandId: 'brand-1',
      contentTypeId: 'igSinglePost',
      existingDraftId: 'draft-existing',
      editDirective: { note: 'new tags please', invalidate: ['hashtags'] },
    });

    expect(mocks.createPostDraft).not.toHaveBeenCalled();
    expect(mocks.initGeneration).toHaveBeenCalledWith('draft-existing', {
      contentTypeId: 'igSinglePost',
      reset: false,
    });
    // hashtags has no downstream dependents in the igSinglePost DAG.
    expect(mocks.invalidateSteps).toHaveBeenCalledWith('draft-existing', {
      steps: ['hashtags'],
      note: 'new tags please',
    });
    const dispatchedSteps = mocks.runCreativeStep.mock.calls.map((c) => c[0].stepId);
    expect(dispatchedSteps).toEqual(['hashtags']);
  });

  it('on rerun with copy invalidation: cascades to hashtags', async () => {
    mocks.invalidateSteps.mockClear();
    mocks.runCreativeStep.mockClear();
    mocks.getGeneration.mockReset();
    mocks.getGeneration.mockResolvedValue(FULL_GENERATION);

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

  it('throws loudly when assembly finds a missing artifact', async () => {
    mocks.runCreativeStep.mockClear();
    mocks.getGeneration.mockReset();
    // Every poll returns a generation that's "done" from the loop's POV
    // (every step appears completed) but is actually missing `copy`. The
    // pipeline still runs assembly and trips the missing-artifact guard.
    const broken: PostDraftGeneration = {
      contentTypeId: 'igSinglePost',
      steps: {
        ideation: FULL_GENERATION.steps.ideation,
        // copy missing
        hashtags: FULL_GENERATION.steps.hashtags,
        artDirection: FULL_GENERATION.steps.artDirection,
        image: FULL_GENERATION.steps.image,
      },
      editHistory: [],
    };
    // First five polls (one per step) make every loop iteration think the
    // step is already done, then the assembly poll returns the broken state.
    for (let i = 0; i < 6; i += 1) mocks.getGeneration.mockResolvedValueOnce(broken);
    // runCreativeStep mock will be invoked for `copy` (the only "missing"
    // step) and we let it resolve, but the broken poll never includes copy.
    mocks.runCreativeStep.mockResolvedValueOnce({ stepId: 'copy', artifact: {} as unknown });

    await expect(
      runCreativePipeline({
        brandId: 'brand-1',
        contentTypeId: 'igSinglePost',
      }),
    ).rejects.toThrow(/did not produce all required artifacts/);
  });
});
