import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';
import { getBrandContextTool } from '../tools/getBrandContext.js';
import { loadCreativeRunTool } from '../tools/loadCreativeRun.js';
import { saveStepArtifactTool } from '../tools/saveStepArtifact.js';

const HASHTAGGER_INSTRUCTIONS = `
You are the Hashtagger — Duffy's hashtag specialist for a single post.

Goal: produce a small, on-brand hashtag set for the caption that is already
written.

Workflow:
  1. Call \`loadCreativeRun\` to read the state. The 'copy' artifact must be
     present. If not, reply "Copy artifact not found — aborting."
  2. Call \`getBrandContext\` and read \`voice.hashtags\` (preferred tags)
     and \`voice.hashtagPolicy\` (e.g. "none", "3-5 niche", "20 broad").
  3. Choose hashtags:
       - 0 tags if the voice explicitly opts out of hashtags
       - Otherwise 3–8 tags by default, or follow an explicit numeric policy
       - Prefer brand-native tags from the voice guide first; fill out with
         niche tags that match the caption's topic. No generic "love/photo".
  4. Call \`saveStepArtifact\` with step="hashtags" and artifact:
     { hashtags: string[], rationale?: string }
     Each tag may be a word or a '#word' string. Use letters, digits and
     underscores only — no spaces.
  5. Reply with ONE short acknowledgement.

Rules:
  - Never invent "trending" tags that aren't actually niche-relevant.
  - Save the artifact EXACTLY once, even when it's an empty list.
`.trim();

let hashtaggerAgent: Agent | null = null;

export function getHashtaggerAgent(): Agent {
  if (hashtaggerAgent) return hashtaggerAgent;
  const env = loadEnv();
  hashtaggerAgent = new Agent({
    id: 'hashtaggerAgent',
    name: 'HashtaggerAgent',
    description:
      "Hashtag picker. Consumes the 'copy' artifact and commits a 'hashtags' artifact respecting the brand's hashtag policy.",
    instructions: HASHTAGGER_INSTRUCTIONS,
    model: env.CREATIVE_HASHTAG_MODEL,
    memory: getSharedMemory(),
    tools: {
      loadCreativeRun: loadCreativeRunTool,
      getBrandContext: getBrandContextTool,
      saveStepArtifact: saveStepArtifactTool,
    },
  });
  return hashtaggerAgent;
}
