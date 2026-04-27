import type { Agent } from '@mastra/core/agent';
import { getCopywriterAgent } from './copywriter.js';
import { getOnboardingAgent } from './onboarding.js';
import { getSchedulerAgent } from './scheduler.js';
import { getStylistAgent } from './stylist.js';

/**
 * Sub-agent registry. The supervisor (Duffy) never imports these directly —
 * it goes through the `delegateTo` tool, which goes through this registry.
 *
 * Adding a new specialist: implement the agent module, then add a key here.
 * The string name is what Duffy passes to `delegateTo({ agentName })`.
 */

export const SUB_AGENT_NAMES = [
  'onboardingAgent',
  'stylistAgent',
  'copywriterAgent',
  'schedulerAgent',
] as const;

export type SubAgentName = (typeof SUB_AGENT_NAMES)[number];

const FACTORIES: Record<SubAgentName, () => Agent> = {
  onboardingAgent: getOnboardingAgent,
  stylistAgent: getStylistAgent,
  copywriterAgent: getCopywriterAgent,
  schedulerAgent: getSchedulerAgent,
};

/**
 * Short, human-readable description of each sub-agent's purpose. We render
 * this into Duffy's instructions and the `delegateTo` schema description so
 * the model has a fighting chance of routing correctly.
 */
export const SUB_AGENT_DESCRIPTIONS: Record<SubAgentName, string> = {
  onboardingAgent:
    "Brand discovery: scrapes a brand's Instagram, analyzes visuals + voice, builds the brand kit/design system/voice guide.",
  stylistAgent:
    'Visual direction: turns brand kit + post brief into image directions and image-generator prompts.',
  copywriterAgent:
    'Caption writing: writes Instagram captions in the brand voice, with optional variants and hashtags.',
  schedulerAgent:
    'Cadence + timing: proposes a posting schedule from a brand cadence + draft list, in the audience timezone.',
};

export function isSubAgentName(name: string): name is SubAgentName {
  return (SUB_AGENT_NAMES as readonly string[]).includes(name);
}

export function getSubAgent(name: SubAgentName): Agent {
  return FACTORIES[name]();
}

export function listSubAgents(): { name: SubAgentName; description: string }[] {
  return SUB_AGENT_NAMES.map((name) => ({
    name,
    description: SUB_AGENT_DESCRIPTIONS[name],
  }));
}
