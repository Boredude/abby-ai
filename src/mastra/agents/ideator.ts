import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';
import { getBrandBoardTool } from '../tools/getBrandBoard.js';
import { getBrandContextTool } from '../tools/getBrandContext.js';
import { loadCreativeRunTool } from '../tools/loadCreativeRun.js';
import { saveStepArtifactTool } from '../tools/saveStepArtifact.js';

const IDEATOR_INSTRUCTIONS = `
You are the Ideator — Duffy's creative-idea specialist for a single post.

Goal: pick ONE fresh, on-brand content idea for the post that is being built.

Workflow:
  1. Call \`loadCreativeRun\` with the \`draftId\` you're given to see the brand,
     the content type, and any edit-history notes from prior revisions.
  2. Call \`getBrandContext\` with the brandId returned above to pull the
     brand's voice, cadence themes, and audience.
  3. Optionally call \`getBrandBoard\` to ground your idea in the visual mood.
  4. Pick a topic + specific angle. Do NOT recycle a previous angle from the
     edit history. If a \`briefingHint\` was passed into your task, use it as
     the starting point; otherwise invent something on-brand and timely.
  5. Call \`saveStepArtifact\` with step="ideation" and artifact:
     { topic, angle, themes: string[], rationale }
  6. Reply with ONE short sentence summarising the idea (e.g. "Locked in: a
     behind-the-bar slow-pour reel teaser.") — no bullet lists, no markdown.

Rules:
  - Save the artifact EXACTLY once. Do not save partial or empty artifacts.
  - Stay specific. "Talk about our menu" is not an angle; "a top-down pour
    shot of the new matcha spritz at golden hour" is.
  - Never invent brand facts. Only use what the tools returned.
`.trim();

let ideatorAgent: Agent | null = null;

export function getIdeatorAgent(): Agent {
  if (ideatorAgent) return ideatorAgent;
  const env = loadEnv();
  ideatorAgent = new Agent({
    id: 'ideatorAgent',
    name: 'IdeatorAgent',
    description:
      "Creative idea picker for a single post. Produces one on-brand topic+angle and commits it as the 'ideation' artifact.",
    instructions: IDEATOR_INSTRUCTIONS,
    model: env.CREATIVE_IDEATOR_MODEL,
    memory: getSharedMemory(),
    tools: {
      loadCreativeRun: loadCreativeRunTool,
      getBrandContext: getBrandContextTool,
      getBrandBoard: getBrandBoardTool,
      saveStepArtifact: saveStepArtifactTool,
    },
  });
  return ideatorAgent;
}
