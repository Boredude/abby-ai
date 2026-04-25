import { describe, expect, it, vi } from 'vitest';

// Stub PostgresStore so constructing the Memory doesn't open a real pool.
vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

import { getDuffyAgent } from '../../src/mastra/agents/duffy.js';
import { getOnboardingAgent } from '../../src/mastra/agents/onboarding.js';

describe('agent wiring', () => {
  it('builds OnboardingAgent with the four Instagram tools', async () => {
    const agent = getOnboardingAgent();
    expect(agent.id).toBe('onboardingAgent');
    expect(agent.name).toBe('OnboardingAgent');
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'analyzeInstagramVisuals',
      'analyzeInstagramVoice',
      'fetchInstagramProfile',
      'saveBrandKit',
    ]);
  });

  it('builds Duffy with onboardingAgent registered as a sub-agent', async () => {
    const duffy = getDuffyAgent();
    expect(duffy.id).toBe('duffy');
    const tools = await duffy.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'generateImage',
      'getBrandProfile',
      'updateBrandProfile',
    ]);

    const subs = await duffy.listAgents();
    expect(Object.keys(subs)).toContain('onboardingAgent');
    expect(subs.onboardingAgent?.id).toBe('onboardingAgent');
  });
});
