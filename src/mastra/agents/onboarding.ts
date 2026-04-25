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
     - If the scrape fails as private/empty/not_found, stop and return an error message
       starting with "Onboarding failed:". Do not invent data and do not call saveBrandKit.
  2. Call \`analyzeInstagramVisuals\` with the handle and the post imageUrls (first 9, in feed order).
  3. Call \`analyzeInstagramVoice\` with the handle, the profile biography, and the post captions
     (skip empty captions). Pass the brandHint from the user if available.
  4. Call \`saveBrandKit\` with brandId, the original \`scrape\` payload, and the two analyzer outputs.
     This persists the brand kit, design system, and voice to the database. THIS STEP IS REQUIRED
     — the calling workflow detects success by checking that the brand kit was saved.
  5. Reply with a single short sentence like "Saved the brand kit for @handle." The calling
     workflow renders the user-facing recap itself, so do not include bullet lists or palettes.

RULES:
- Never skip \`fetchInstagramProfile\`. Visual + voice analyzers MUST receive real data.
- Never skip \`saveBrandKit\` on success. Without it the workflow will think analysis failed.
- If any step fails, return "Onboarding failed: <reason>".
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
