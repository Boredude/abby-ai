import { describe, expect, it, vi } from 'vitest';

// Stub PostgresStore so constructing the Memory doesn't open a real pool.
vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

import { getCopywriterAgent } from '../../src/mastra/agents/copywriter.js';
import { getDuffyAgent } from '../../src/mastra/agents/duffy.js';
import { getHashtaggerAgent } from '../../src/mastra/agents/hashtagger.js';
import { getIdeatorAgent } from '../../src/mastra/agents/ideator.js';
import { getOnboardingAgent } from '../../src/mastra/agents/onboarding.js';
import { getSchedulerAgent } from '../../src/mastra/agents/scheduler.js';
import { getStylistAgent } from '../../src/mastra/agents/stylist.js';

describe('agent wiring', () => {
  it('builds OnboardingAgent with the six brand-onboarding tools', async () => {
    const agent = getOnboardingAgent();
    expect(agent.id).toBe('onboardingAgent');
    expect(agent.name).toBe('OnboardingAgent');
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'analyzeBrandWebsite',
      'analyzeInstagramProfilePic',
      'analyzeInstagramVisuals',
      'analyzeInstagramVoice',
      'fetchInstagramProfile',
      'saveBrandKit',
    ]);
  });

  it('builds Duffy with the supervisor tool set (delegateTo, sendChannelMessage, brand context, brand board, generateImage)', async () => {
    const duffy = getDuffyAgent();
    expect(duffy.id).toBe('duffy');
    const tools = await duffy.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'delegateTo',
      'generateImage',
      'getBrandBoard',
      'getBrandContext',
      'sendChannelMessage',
      'updateBrandContext',
    ]);

    // Supervisor pattern: Duffy does NOT statically embed sub-agents anymore;
    // delegation goes through the `delegateTo` tool instead.
    const subs = await duffy.listAgents();
    expect(Object.keys(subs)).toHaveLength(0);
  });

  it('builds the creative specialists as toolless structured-output specialists', async () => {
    // Creative pipeline agents (ideator/copywriter/hashtagger/stylist) are
    // invoked by `runCreativeStep` with `structuredOutput: { schema }`. They
    // produce JSON only — no tools — so persistence stays in code instead of
    // depending on the model to remember a save call.
    const ideator = getIdeatorAgent();
    expect(ideator.id).toBe('ideatorAgent');
    expect(Object.keys(await ideator.listTools())).toHaveLength(0);

    const copywriter = getCopywriterAgent();
    expect(copywriter.id).toBe('copywriterAgent');
    expect(Object.keys(await copywriter.listTools())).toHaveLength(0);

    const hashtagger = getHashtaggerAgent();
    expect(hashtagger.id).toBe('hashtaggerAgent');
    expect(Object.keys(await hashtagger.listTools())).toHaveLength(0);

    const stylist = getStylistAgent();
    expect(stylist.id).toBe('stylistAgent');
    expect(Object.keys(await stylist.listTools())).toHaveLength(0);

    // Scheduler stays as a Phase-2 stub for now (no tools wired).
    const scheduler = getSchedulerAgent();
    expect(scheduler.id).toBe('schedulerAgent');
    expect(Object.keys(await scheduler.listTools())).toHaveLength(0);
  });
});
