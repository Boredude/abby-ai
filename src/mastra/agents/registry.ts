import type { Agent } from '@mastra/core/agent';
import { getCopywriterAgent } from './copywriter.js';
import { getCreativeDirectorAgent } from './creativeDirector.js';
import { getHashtaggerAgent } from './hashtagger.js';
import { getIdeatorAgent } from './ideator.js';
import { getImageGenAgent } from './imageGen.js';
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
  'creativeDirectorAgent',
  'stylistAgent',
  'copywriterAgent',
  'ideatorAgent',
  'hashtaggerAgent',
  'imageGenAgent',
  'schedulerAgent',
] as const;

export type SubAgentName = (typeof SUB_AGENT_NAMES)[number];

const FACTORIES: Record<SubAgentName, () => Agent> = {
  onboardingAgent: getOnboardingAgent,
  creativeDirectorAgent: getCreativeDirectorAgent,
  stylistAgent: getStylistAgent,
  copywriterAgent: getCopywriterAgent,
  ideatorAgent: getIdeatorAgent,
  hashtaggerAgent: getHashtaggerAgent,
  imageGenAgent: getImageGenAgent,
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
  creativeDirectorAgent:
    "Runs the full creative pipeline for ONE post (or reel, carousel, etc.). Delegates to ideator/copywriter/hashtagger/stylist/imageGen in order and returns when every step's artifact is persisted on the draft.",
  stylistAgent:
    "Art director. Consumes 'ideation' + brand kit and commits an 'artDirection' artifact (subject/composition/lighting/palette/mood + imagePrompt).",
  copywriterAgent:
    "Caption writer. Consumes the 'ideation' artifact and commits a 'copy' artifact (hook + body + cta + fullCaption) in the brand voice.",
  ideatorAgent:
    "Picks ONE fresh, on-brand topic+angle for a post. Commits an 'ideation' artifact.",
  hashtaggerAgent:
    "Hashtag picker. Consumes 'copy' and commits a 'hashtags' artifact respecting the brand's hashtag policy.",
  imageGenAgent:
    "Image renderer. Consumes 'artDirection', calls the image model, and commits an 'image' artifact (public URL).",
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
