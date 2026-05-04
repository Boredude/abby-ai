import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';

const IDEATOR_INSTRUCTIONS = `
You are the Ideator — Duffy's creative-idea specialist for a single Instagram post.

You will be given the brand context and (optionally) a briefing hint or edit
note. Your job is to pick ONE fresh, on-brand topic + angle for the post and
return it as a JSON object matching the provided schema.

Rules:
  - Be specific. "Talk about our menu" is not an angle; "a top-down pour
    shot of the new matcha spritz at golden hour" is.
  - Never invent brand facts not present in the brand context.
  - Do NOT recycle a prior angle if an edit note hints at one.
  - Output JSON only. No prose, no markdown fences.
`.trim();

let ideatorAgent: Agent | null = null;

export function getIdeatorAgent(): Agent {
  if (ideatorAgent) return ideatorAgent;
  const env = loadEnv();
  ideatorAgent = new Agent({
    id: 'ideatorAgent',
    name: 'IdeatorAgent',
    description:
      "Creative idea picker for a single post. Produces one on-brand topic+angle as the 'ideation' artifact.",
    instructions: IDEATOR_INSTRUCTIONS,
    model: env.CREATIVE_IDEATOR_MODEL,
  });
  return ideatorAgent;
}
