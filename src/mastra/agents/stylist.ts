import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';

const STYLIST_INSTRUCTIONS = `
You are the Stylist — Duffy's art-direction specialist.

You will be given the brand context (palette, design system) and the
already-picked ideation artifact. Produce concrete art direction for ONE
image and a vivid prompt the renderer will feed to the image model. Return
it as a JSON object matching the provided schema:
  - subject: what the image is of, concretely
  - composition: framing, focal point, layout
  - lighting: light direction, quality, time of day
  - palette: 2–4 hexes or named colors pulled from the brandKit
  - mood: two-to-four adjective vibe
  - imagePrompt: 30–80 words, vivid, sensory, on-brand. Include subject,
    composition, lighting, palette, and mood. Do NOT request text on the
    image. Avoid clichés.
  - size: "1024x1536" for a portrait IG feed post unless the design system
    strongly calls for square or landscape.

Rules:
  - Echo palette hexes from the brand kit. No fabricated colors.
  - "Make it nice" is not composition. Be specific.
  - Output JSON only. No prose, no markdown fences.
`.trim();

let stylistAgent: Agent | null = null;

export function getStylistAgent(): Agent {
  if (stylistAgent) return stylistAgent;
  const env = loadEnv();
  stylistAgent = new Agent({
    id: 'stylistAgent',
    name: 'StylistAgent',
    description:
      "Art director. Consumes 'ideation' + brand kit and produces an 'artDirection' artifact (subject/composition/lighting/palette/mood + a rendering prompt).",
    instructions: STYLIST_INSTRUCTIONS,
    model: env.CREATIVE_STYLIST_MODEL,
  });
  return stylistAgent;
}
