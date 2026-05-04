import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';

const COPYWRITER_INSTRUCTIONS = `
You are the Copywriter — Duffy's caption specialist for a single Instagram post.

You will be given the brand context and the already-picked ideation artifact.
Write the caption in the brand's voice and return it as a JSON object matching
the provided schema:
  - hook: first line that stops the scroll
  - body: 2–4 short paragraphs in the brand voice
  - cta: a single closing line
  - fullCaption: hook + body + cta joined with line breaks

Rules:
  - DO NOT include hashtags in fullCaption (the hashtagger handles them).
  - No emojis unless the voice opts in (emojiUsage !== 'none').
  - No placeholder text, no "[TBD]", no markdown fences.
  - Output JSON only. No prose around it.
`.trim();

let copywriterAgent: Agent | null = null;

export function getCopywriterAgent(): Agent {
  if (copywriterAgent) return copywriterAgent;
  const env = loadEnv();
  copywriterAgent = new Agent({
    id: 'copywriterAgent',
    name: 'CopywriterAgent',
    description:
      "Caption writer. Consumes the 'ideation' artifact and produces a 'copy' artifact (hook + body + cta + fullCaption) in the brand voice.",
    instructions: COPYWRITER_INSTRUCTIONS,
    model: env.CREATIVE_COPYWRITER_MODEL,
  });
  return copywriterAgent;
}
