import type { Agent } from '@mastra/core/agent';
import { getCopywriterAgent } from './copywriter.js';
import { getHashtaggerAgent } from './hashtagger.js';
import { getIdeatorAgent } from './ideator.js';
import { getOnboardingAgent } from './onboarding.js';
import { getSchedulerAgent } from './scheduler.js';
import { getStylistAgent } from './stylist.js';

/**
 * Sub-agent registry. The supervisor (Duffy) never imports these directly —
 * it goes through the `delegateTo` tool, which goes through this registry.
 *
 * Adding a new specialist: implement the agent module, then add a key here.
 * The string name is what Duffy passes to `delegateTo({ agentName })`.
 *
 * Note: the creative pipeline (ideator, copywriter, hashtagger, stylist) is
 * driven deterministically by `runCreativePipeline` / `runCreativeStep`, not
 * by Duffy's `delegateTo`. Those agents stay in the registry so the Mastra
 * runtime can introspect them (telemetry, dashboards), but Duffy should not
 * route work to them — the slash command path handles content generation.
 */

export const SUB_AGENT_NAMES = [
  'onboardingAgent',
  'stylistAgent',
  'copywriterAgent',
  'ideatorAgent',
  'hashtaggerAgent',
  'schedulerAgent',
] as const;

export type SubAgentName = (typeof SUB_AGENT_NAMES)[number];

const FACTORIES: Record<SubAgentName, () => Agent> = {
  onboardingAgent: getOnboardingAgent,
  stylistAgent: getStylistAgent,
  copywriterAgent: getCopywriterAgent,
  ideatorAgent: getIdeatorAgent,
  hashtaggerAgent: getHashtaggerAgent,
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
    "Art director. Consumes 'ideation' + brand kit and produces an 'artDirection' artifact (subject/composition/lighting/palette/mood + imagePrompt). Driven by the creative pipeline; not for direct delegation.",
  copywriterAgent:
    "Caption writer. Consumes the 'ideation' artifact and produces a 'copy' artifact (hook + body + cta + fullCaption) in the brand voice. Driven by the creative pipeline; not for direct delegation.",
  ideatorAgent:
    "Picks ONE fresh, on-brand topic+angle for a post. Produces an 'ideation' artifact. Driven by the creative pipeline; not for direct delegation.",
  hashtaggerAgent:
    "Hashtag picker. Consumes 'copy' and produces a 'hashtags' artifact respecting the brand's hashtag policy. Driven by the creative pipeline; not for direct delegation.",
  schedulerAgent:
    "Cadence + timing specialist. Proposes posting schedules from a brand cadence + draft list.",
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
