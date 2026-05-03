import { describe, expect, it, vi } from 'vitest';
import type { PostDraftGeneration } from '../../src/services/creative/types.js';

const mocks = vi.hoisted(() => ({
  findDraftById: vi.fn(async (_id: string) => ({
    id: 'draft-1',
    brandId: 'brand-1',
    caption: '',
    mediaUrls: [],
    status: 'draft',
  })),
  getGeneration: vi.fn(async (_id: string) => null as PostDraftGeneration | null),
}));

vi.mock('../../src/db/repositories/postDrafts.js', () => ({
  findDraftById: mocks.findDraftById,
}));

vi.mock('../../src/db/repositories/draftGenerations.js', () => ({
  getGeneration: mocks.getGeneration,
}));

import { loadCreativeRunTool } from '../../src/mastra/tools/loadCreativeRun.js';

type Execute = NonNullable<typeof loadCreativeRunTool.execute>;
const exec = loadCreativeRunTool.execute as Execute;

type ToolResult = {
  draftId: string;
  brandId: string;
  contentTypeId: string;
  briefingHint: string | null;
  pipeline: Array<{ id: string; agentName: string; dependsOn: string[]; description: string }>;
  completedSteps: Array<{ id: string; artifact: unknown }>;
  missingSteps: Array<{ id: string; agentName: string; dependsOnReady: boolean }>;
  editHistory: Array<{ at: string; note: string; invalidated: string[] }>;
};

async function run(input: Parameters<Execute>[0]): Promise<ToolResult> {
  return (await exec(input, {} as Parameters<Execute>[1])) as ToolResult;
}

describe('loadCreativeRun tool', () => {
  it('errors when the draft has no generation blob', async () => {
    mocks.getGeneration.mockResolvedValueOnce(null);
    await expect(run({ draftId: 'draft-1' })).rejects.toThrow(/no generation blob/);
  });

  it('reports all steps missing on a fresh generation', async () => {
    mocks.getGeneration.mockResolvedValueOnce({
      contentTypeId: 'igSinglePost',
      steps: {},
      editHistory: [],
    });
    const out = await run({ draftId: 'draft-1' });
    expect(out.brandId).toBe('brand-1');
    expect(out.pipeline.map((s) => s.id)).toEqual([
      'ideation',
      'copy',
      'hashtags',
      'artDirection',
      'image',
    ]);
    expect(out.completedSteps).toEqual([]);
    expect(out.missingSteps.map((s) => s.id)).toEqual([
      'ideation',
      'copy',
      'hashtags',
      'artDirection',
      'image',
    ]);
    // Only ideation has no deps, so it's the only ready one at the start.
    expect(out.missingSteps.filter((s) => s.dependsOnReady).map((s) => s.id)).toEqual([
      'ideation',
    ]);
  });

  it('marks downstream steps ready once their deps are complete', async () => {
    mocks.getGeneration.mockResolvedValueOnce({
      contentTypeId: 'igSinglePost',
      steps: {
        ideation: {
          topic: 't',
          angle: 'a sufficiently long angle',
          themes: [],
          rationale: 'r',
        },
      },
      editHistory: [],
    });
    const out = await run({ draftId: 'draft-1' });
    expect(out.completedSteps.map((s) => s.id)).toEqual(['ideation']);
    const readyIds = out.missingSteps.filter((s) => s.dependsOnReady).map((s) => s.id);
    // copy (deps: ideation) AND artDirection (deps: ideation) should both be ready.
    expect(readyIds.sort()).toEqual(['artDirection', 'copy']);
  });

  it('surfaces the latest edit-history note as briefingHint', async () => {
    mocks.getGeneration.mockResolvedValueOnce({
      contentTypeId: 'igSinglePost',
      steps: {},
      editHistory: [
        { at: '2024-01-01T00:00:00Z', note: 'first pass', invalidated: ['copy'] },
        { at: '2024-01-02T00:00:00Z', note: 'make it punchier', invalidated: ['copy'] },
      ],
    });
    const out = await run({ draftId: 'draft-1' });
    expect(out.briefingHint).toBe('make it punchier');
  });
});
