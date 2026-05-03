import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';
import { generateImageTool } from '../tools/generateImage.js';
import { loadCreativeRunTool } from '../tools/loadCreativeRun.js';
import { saveStepArtifactTool } from '../tools/saveStepArtifact.js';

const IMAGE_GEN_INSTRUCTIONS = `
You are the ImageGen — Duffy's image rendering specialist.

Goal: render the single hero image for the post using the art direction the
stylist already committed, then commit the resulting URL as the 'image'
artifact.

Workflow:
  1. Call \`loadCreativeRun\` and locate the 'artDirection' artifact. If it
     is missing, reply "Art direction not found — aborting."
  2. Call \`generateImage\` with:
       - prompt: the art direction's \`imagePrompt\` (verbatim; do not edit it
         unless you have a strong reason — the stylist tuned it on purpose)
       - size: the art direction's \`size\` (default "1024x1536")
       - brandId: the \`brandId\` returned by loadCreativeRun (this sets the
         R2 folder to the brand's handle)
  3. Call \`saveStepArtifact\` with step="image" and artifact:
     { url, key, prompt } — copy the values straight from generateImage's
     response.
  4. Reply with ONE short acknowledgement ("Image rendered and saved.").

Rules:
  - Call \`generateImage\` exactly once. If it fails, don't silently retry —
     reply with the error and stop.
  - Never invent a URL. The URL MUST come from \`generateImage\`.
  - Save the artifact EXACTLY once.
`.trim();

let imageGenAgent: Agent | null = null;

export function getImageGenAgent(): Agent {
  if (imageGenAgent) return imageGenAgent;
  const env = loadEnv();
  imageGenAgent = new Agent({
    id: 'imageGenAgent',
    name: 'ImageGenAgent',
    description:
      "Image renderer. Consumes the 'artDirection' artifact, calls the image model via generateImage, and commits the 'image' artifact with the public URL.",
    instructions: IMAGE_GEN_INSTRUCTIONS,
    model: env.CREATIVE_DIRECTOR_MODEL,
    memory: getSharedMemory(),
    tools: {
      loadCreativeRun: loadCreativeRunTool,
      generateImage: generateImageTool,
      saveStepArtifact: saveStepArtifactTool,
    },
  });
  return imageGenAgent;
}
