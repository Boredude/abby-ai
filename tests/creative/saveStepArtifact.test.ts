import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setStepArtifact: vi.fn(async (_draftId: string, input: unknown) => {
    const { step } = input as { step: string };
    return {
      contentTypeId: 'igSinglePost',
      steps: { [step]: {} },
      editHistory: [],
    };
  }),
}));

vi.mock('../../src/db/repositories/draftGenerations.js', () => ({
  setStepArtifact: mocks.setStepArtifact,
}));

import { saveStepArtifactTool } from '../../src/mastra/tools/saveStepArtifact.js';

type Execute = NonNullable<typeof saveStepArtifactTool.execute>;
const exec = saveStepArtifactTool.execute as Execute;

type ToolResult = {
  draftId: string;
  step: string;
  completedSteps: string[];
};

async function run(input: Parameters<Execute>[0]): Promise<ToolResult> {
  return (await exec(input, {} as Parameters<Execute>[1])) as ToolResult;
}

describe('saveStepArtifact tool', () => {
  it('commits a valid copy artifact and returns completed steps', async () => {
    const result = await run({
      draftId: 'draft-1',
      step: 'copy',
      artifact: {
        hook: 'Hook line.',
        body: 'Body paragraph long enough.',
        cta: 'Call to action.',
        fullCaption: 'Hook line. Body paragraph long enough. Call to action.',
      },
    });
    expect(result.step).toBe('copy');
    expect(result.completedSteps).toEqual(['copy']);
    expect(mocks.setStepArtifact).toHaveBeenCalledOnce();
  });

  it('rejects an artifact whose shape does not match its step', async () => {
    await expect(
      run({
        draftId: 'draft-1',
        step: 'hashtags',
        // This is a copy-shaped artifact sent as hashtags — should fail schema.
        artifact: { hook: 'h', body: 'b', cta: 'c', fullCaption: 'long enough' },
      }),
    ).rejects.toThrow(/does not match schema for step 'hashtags'/);
  });

  it('rejects a hashtags artifact containing spaces', async () => {
    await expect(
      run({
        draftId: 'draft-1',
        step: 'hashtags',
        artifact: { hashtags: ['has a space'] },
      }),
    ).rejects.toThrow(/does not match schema/);
  });
});
