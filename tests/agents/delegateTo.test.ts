import { describe, expect, it, vi } from 'vitest';
import type * as RegistryModule from '../../src/mastra/agents/registry.js';

vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

const mocks = vi.hoisted(() => ({
  stylistGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'stylist response  ' })),
  copywriterGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'copywriter response' })),
  schedulerGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'scheduler response' })),
  onboardingGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'onboarding response' })),
}));

vi.mock('../../src/mastra/agents/registry.js', async () => {
  const actual = await vi.importActual<typeof RegistryModule>(
    '../../src/mastra/agents/registry.js',
  );
  return {
    ...actual,
    getSubAgent: vi.fn((name: string) => {
      switch (name) {
        case 'stylistAgent':
          return { generate: mocks.stylistGenerate };
        case 'copywriterAgent':
          return { generate: mocks.copywriterGenerate };
        case 'schedulerAgent':
          return { generate: mocks.schedulerGenerate };
        case 'onboardingAgent':
          return { generate: mocks.onboardingGenerate };
        default:
          throw new Error(`unknown ${name}`);
      }
    }),
  };
});

import { delegateToTool } from '../../src/mastra/tools/delegateTo.js';

type Execute = NonNullable<typeof delegateToTool.execute>;
const exec = delegateToTool.execute as Execute;

async function run(input: Parameters<Execute>[0]) {
  return exec(input, {} as Parameters<Execute>[1]);
}

describe('delegateTo tool', () => {
  it('routes to the requested sub-agent and returns a trimmed response', async () => {
    const result = await run({
      agentName: 'stylistAgent',
      task: 'Direct a hero shot for the upcoming launch post.',
      brandId: 'brand-1',
    });
    expect(result).toEqual({ agentName: 'stylistAgent', response: 'stylist response' });
    expect(mocks.stylistGenerate).toHaveBeenCalledTimes(1);
    expect(mocks.copywriterGenerate).not.toHaveBeenCalled();
  });

  it('passes the brand memory thread when brandId is provided', async () => {
    mocks.copywriterGenerate.mockClear();
    await run({
      agentName: 'copywriterAgent',
      task: 'Write three caption variants for the launch post.',
      brandId: 'brand-7',
    });
    const callArgs = mocks.copywriterGenerate.mock.calls[0];
    expect(callArgs?.[1]).toEqual({ memory: { thread: 'brand:brand-7', resource: 'brand-7' } });
  });

  it('appends structured context as JSON when provided', async () => {
    mocks.schedulerGenerate.mockClear();
    await run({
      agentName: 'schedulerAgent',
      task: 'Propose timestamps for the next 3 posts.',
      brandId: 'brand-9',
      context: { postsPerWeek: 3, timezone: 'America/New_York' },
    });
    const prompt = mocks.schedulerGenerate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('Propose timestamps');
    expect(prompt).toContain('"postsPerWeek": 3');
    expect(prompt).toContain('"timezone": "America/New_York"');
  });
});
