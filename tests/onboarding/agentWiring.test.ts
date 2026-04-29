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
import { getOnboardingAgent } from '../../src/mastra/agents/onboarding.js';
import { getSchedulerAgent } from '../../src/mastra/agents/scheduler.js';
import { getStylistAgent } from '../../src/mastra/agents/stylist.js';

describe('agent wiring', () => {
  it('builds OnboardingAgent with the five Instagram tools', async () => {
    const agent = getOnboardingAgent();
    expect(agent.id).toBe('onboardingAgent');
    expect(agent.name).toBe('OnboardingAgent');
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'analyzeInstagramProfilePic',
      'analyzeInstagramVisuals',
      'analyzeInstagramVoice',
      'fetchInstagramProfile',
      'saveBrandKit',
    ]);
  });

  it('builds Duffy with the supervisor tool set (delegateTo, sendChannelMessage, brand context, generateImage)', async () => {
    const duffy = getDuffyAgent();
    expect(duffy.id).toBe('duffy');
    const tools = await duffy.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'delegateTo',
      'generateImage',
      'getBrandContext',
      'sendChannelMessage',
      'updateBrandContext',
    ]);

    // Supervisor pattern: Duffy does NOT statically embed sub-agents anymore;
    // delegation goes through the `delegateTo` tool instead.
    const subs = await duffy.listAgents();
    expect(Object.keys(subs)).toHaveLength(0);
  });

  it('builds the three Phase-2 stub sub-agents (stylist, copywriter, scheduler) with no tools', async () => {
    const stylist = getStylistAgent();
    expect(stylist.id).toBe('stylistAgent');
    expect(Object.keys(await stylist.listTools())).toHaveLength(0);

    const copywriter = getCopywriterAgent();
    expect(copywriter.id).toBe('copywriterAgent');
    expect(Object.keys(await copywriter.listTools())).toHaveLength(0);

    const scheduler = getSchedulerAgent();
    expect(scheduler.id).toBe('schedulerAgent');
    expect(Object.keys(await scheduler.listTools())).toHaveLength(0);
  });
});
