import { getDuffyAgent } from './duffy.js';
import { getOnboardingAgent } from './onboarding.js';

/**
 * Lazy registry. We construct each agent on first access so that env validation
 * surfaces only once it's actually needed (helpful for tests).
 */
export function buildAgents() {
  return {
    duffy: getDuffyAgent(),
    onboardingAgent: getOnboardingAgent(),
  };
}

export const agents = new Proxy({} as ReturnType<typeof buildAgents>, {
  get(_t, prop: string) {
    return buildAgents()[prop as keyof ReturnType<typeof buildAgents>];
  },
});
