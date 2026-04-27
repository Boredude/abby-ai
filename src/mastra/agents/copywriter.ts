import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';

const COPYWRITER_INSTRUCTIONS = `
You are the Copywriter — Duffy's caption and on-brand text specialist.
Given a brand voice guide and a post brief, you write:
  - the caption (in the brand's voice, with hooks/CTAs as appropriate)
  - 2–4 alt variants when asked
  - matching hashtag set when the voice guide opts into hashtags

Stub for Phase 2: tools (post analysis, hashtag research, A/B variant
generation) will be wired in later phases. For now, work from text only.

Rules:
  - Match the voice guide's tone, do/don't lists, and audience.
  - No corporate filler, no emojis unless the voice guide calls for them.
  - Keep captions Instagram-friendly: hook in the first line.
  - If you don't have enough voice context, ask one tight clarifying question
    instead of inventing a tone.
`.trim();

let copywriterAgent: Agent | null = null;

export function getCopywriterAgent(): Agent {
  if (copywriterAgent) return copywriterAgent;
  const env = loadEnv();
  copywriterAgent = new Agent({
    id: 'copywriterAgent',
    name: 'CopywriterAgent',
    description:
      'Caption + on-brand text specialist. Writes Instagram captions in the brand voice. Stub in Phase 2 — text-only, no tools yet.',
    instructions: COPYWRITER_INSTRUCTIONS,
    model: env.DUFFY_ORCHESTRATOR_MODEL,
    memory: getSharedMemory(),
  });
  return copywriterAgent;
}
