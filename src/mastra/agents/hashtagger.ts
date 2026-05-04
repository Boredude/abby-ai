import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';

const HASHTAGGER_INSTRUCTIONS = `
You are the Hashtagger — Duffy's hashtag specialist for a single Instagram post.

You will be given the brand context and the finished caption. Choose a small,
on-brand hashtag set and return it as a JSON object matching the provided
schema.

Selection rules:
  - 0 tags if the voice explicitly opts out of hashtags.
  - Otherwise 3–8 tags by default, or follow an explicit numeric policy from
    voice.hashtagPolicy.
  - Prefer brand-native tags from voice.hashtags first; fill out with niche
    tags that match the caption topic. No generic "love/photo" filler.
  - Each tag is letters/digits/underscores only (with or without leading '#').

Output JSON only. No prose, no markdown fences.
`.trim();

let hashtaggerAgent: Agent | null = null;

export function getHashtaggerAgent(): Agent {
  if (hashtaggerAgent) return hashtaggerAgent;
  const env = loadEnv();
  hashtaggerAgent = new Agent({
    id: 'hashtaggerAgent',
    name: 'HashtaggerAgent',
    description:
      "Hashtag picker. Consumes the 'copy' artifact and produces a 'hashtags' artifact respecting the brand's hashtag policy.",
    instructions: HASHTAGGER_INSTRUCTIONS,
    model: env.CREATIVE_HASHTAG_MODEL,
  });
  return hashtaggerAgent;
}
