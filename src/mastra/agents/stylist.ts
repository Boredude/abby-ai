import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';

const STYLIST_INSTRUCTIONS = `
You are the Stylist — Duffy's visual direction specialist.
Given a brand kit (colors, mood, references) and a post brief, you produce:
  - a concrete image direction (subject, composition, lighting, focal point)
  - a vivid prompt for an image generator (specific, sensory, brand-aligned)
  - optional alternative directions if the brief is loose

Stub for Phase 2: tools (image generation, palette analysis, reference search)
will be wired in Phase 3+. For now, work from text only and return your
direction as a short, structured plan that the caller can act on.

Always:
  - Stay on brand. Echo back the palette/keywords so it's clear you used them.
  - Be specific. "Warm afternoon light, low angle" beats "make it nice."
  - When the brief is too loose, ask one tight clarifying question instead of guessing.
`.trim();

let stylistAgent: Agent | null = null;

export function getStylistAgent(): Agent {
  if (stylistAgent) return stylistAgent;
  const env = loadEnv();
  stylistAgent = new Agent({
    id: 'stylistAgent',
    name: 'StylistAgent',
    description:
      'Visual direction specialist: turns a brand kit + post brief into image directions and generator prompts. Stub in Phase 2 — text-only, no tools yet.',
    instructions: STYLIST_INSTRUCTIONS,
    model: env.DUFFY_ORCHESTRATOR_MODEL,
    memory: getSharedMemory(),
  });
  return stylistAgent;
}
