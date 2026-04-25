import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { loadEnv } from '../../config/env.js';
import {
  analyzeInstagramVisualsTool,
  analyzeInstagramVoiceTool,
  fetchInstagramProfileTool,
  saveBrandKitTool,
} from '../tools/instagram/index.js';

const ONBOARDING_INSTRUCTIONS = `
You are the OnboardingAgent — a brand discovery specialist working on behalf of Abby.
Given a brand's Instagram handle and brandId, you autonomously:

  1. Call \`fetchInstagramProfile\` with the handle to pull profile metadata + the most recent posts.
     - If the scrape fails as private/empty/not_found, stop and report it back as an error message; do not invent data.
  2. Call \`analyzeInstagramVisuals\` with the handle and the post imageUrls (first 9, in feed order).
  3. Call \`analyzeInstagramVoice\` with the handle, the profile biography, and the post captions
     (skip empty captions). Pass the brandHint from the user if available.
  4. Call \`saveBrandKit\` with brandId, the original \`scrape\` payload, and the two analyzer outputs.
     This persists the brand kit, design system, and voice to the database.
  5. Return a short, WhatsApp-friendly recap with:
     - one-paragraph summary of who the brand is and how they sound
     - 3–5 palette colors (hex + role/name)
     - 3 voice tone adjectives + emoji and hashtag policy
     - 3 visual do/don't bullets
     End with: "Want me to lock this in or tweak something?"

RULES:
- Never skip the scrape step. Visual + voice analyzers MUST receive real data from \`fetchInstagramProfile\`.
- Always call \`saveBrandKit\` before returning your recap to Abby.
- Keep the recap under 800 characters total. Use bullet lists.
- If a step fails, return an error message starting with "Onboarding failed:" so Abby can surface it cleanly.
`.trim();

let onboardingMemory: Memory | null = null;
let onboardingAgent: Agent | null = null;

function getOnboardingMemory(): Memory {
  if (onboardingMemory) return onboardingMemory;
  const env = loadEnv();
  const storage = new PostgresStore({
    id: 'onboarding-memory-storage',
    connectionString: env.DATABASE_URL,
  });
  onboardingMemory = new Memory({ storage });
  return onboardingMemory;
}

export function getOnboardingAgent(): Agent {
  if (onboardingAgent) return onboardingAgent;
  const env = loadEnv();
  onboardingAgent = new Agent({
    id: 'onboardingAgent',
    name: 'OnboardingAgent',
    description:
      "Analyzes a brand's Instagram (visuals + captions via Apify) and produces a brand kit, design system, and voice guide. Used by Abby during initial onboarding.",
    instructions: ONBOARDING_INSTRUCTIONS,
    model: env.ONBOARDING_AGENT_MODEL,
    memory: getOnboardingMemory(),
    tools: {
      fetchInstagramProfile: fetchInstagramProfileTool,
      analyzeInstagramVisuals: analyzeInstagramVisualsTool,
      analyzeInstagramVoice: analyzeInstagramVoiceTool,
      saveBrandKit: saveBrandKitTool,
    },
  });
  return onboardingAgent;
}
