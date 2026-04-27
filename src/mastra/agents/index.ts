import { getCopywriterAgent } from './copywriter.js';
import { getDuffyAgent } from './duffy.js';
import { getOnboardingAgent } from './onboarding.js';
import { getSchedulerAgent } from './scheduler.js';
import { getStylistAgent } from './stylist.js';

/**
 * Lazy registry. We construct each agent on first access so that env validation
 * surfaces only once it's actually needed (helpful for tests).
 *
 * Sub-agents are registered here so that `mastra.getAgent('stylistAgent')` works,
 * but Duffy itself does NOT statically embed them — it routes through the
 * `delegateTo` tool (which goes through `agents/registry.ts`).
 */
export function buildAgents() {
  return {
    duffy: getDuffyAgent(),
    onboardingAgent: getOnboardingAgent(),
    stylistAgent: getStylistAgent(),
    copywriterAgent: getCopywriterAgent(),
    schedulerAgent: getSchedulerAgent(),
  };
}

export const agents = new Proxy({} as ReturnType<typeof buildAgents>, {
  get(_t, prop: string) {
    return buildAgents()[prop as keyof ReturnType<typeof buildAgents>];
  },
});
