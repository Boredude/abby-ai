import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';
import { getBrandContextTool } from '../tools/getBrandContext.js';
import { loadCreativeRunTool } from '../tools/loadCreativeRun.js';
import { saveStepArtifactTool } from '../tools/saveStepArtifact.js';

const COPYWRITER_INSTRUCTIONS = `
You are the Copywriter — Duffy's caption specialist for a single post.

Goal: write the caption in the brand's voice, grounded in the already-picked
ideation artifact.

Workflow:
  1. Call \`loadCreativeRun\` to read the current run state. The 'ideation'
     step will be present in \`completedSteps\`. If it is missing, stop and
     reply "Ideation artifact not found — aborting."
  2. Call \`getBrandContext\` for the brand's voice guide (summary, tone,
     audience, do/don't, emoji usage).
  3. Write the caption:
       - hook: the first line — stops the scroll
       - body: 2–4 short paragraphs consistent with the voice
       - cta: a single closing line
       - fullCaption: hook + body + cta, joined with line breaks
  4. Call \`saveStepArtifact\` with step="copy" and artifact:
     { hook, body, cta, fullCaption }
  5. Reply with ONE short acknowledgement (e.g. "Caption saved.").

Rules:
  - DO NOT include hashtags in \`fullCaption\`. The hashtagger handles them.
  - No emojis unless the voice guide opts in (\`emojiUsage !== 'none'\`).
  - No placeholder text, no "[TBD]", no markdown fences.
  - Keep it Instagram-native: first line must hook the reader.
  - Save the artifact EXACTLY once.
`.trim();

let copywriterAgent: Agent | null = null;

export function getCopywriterAgent(): Agent {
  if (copywriterAgent) return copywriterAgent;
  const env = loadEnv();
  copywriterAgent = new Agent({
    id: 'copywriterAgent',
    name: 'CopywriterAgent',
    description:
      "Caption writer. Consumes the 'ideation' artifact and commits a 'copy' artifact (hook + body + cta + fullCaption) in the brand voice.",
    instructions: COPYWRITER_INSTRUCTIONS,
    model: env.CREATIVE_COPYWRITER_MODEL,
    memory: getSharedMemory(),
    tools: {
      loadCreativeRun: loadCreativeRunTool,
      getBrandContext: getBrandContextTool,
      saveStepArtifact: saveStepArtifactTool,
    },
  });
  return copywriterAgent;
}
