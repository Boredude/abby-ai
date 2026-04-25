import OpenAI from 'openai';
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { findBrandById } from '../db/repositories/brands.js';
import { generateAndStoreImage } from './media/generateImage.js';

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (openai) return openai;
  const env = loadEnv();
  openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openai;
}

export type GeneratedDraft = {
  caption: string;
  imageUrl: string;
  imagePrompt: string;
};

const SYSTEM_PROMPT = `
You are Duffy, an Instagram content strategist. You produce a single Instagram post — a
caption and an image-generation prompt — that fits the brand's voice. Output strict JSON
with this schema:

{
  "caption": string,           // 80-180 words, ends with 3-5 relevant hashtags on a new line
  "imagePrompt": string        // 30-60 words, vivid description of the image to generate
}

Rules:
- Match the brand's voice and audience precisely.
- The caption must be Instagram-native: a hook in the first line, body, then call-to-action.
- The image prompt must be specific (subject, composition, lighting, color palette, mood).
- No emojis unless the brand voice explicitly favors them.
- Never include placeholder text like "[insert ...]" or "TBD".
`.trim();

export async function generateDraftForBrand(args: {
  brandId: string;
  briefingHint?: string;
}): Promise<GeneratedDraft> {
  const env = loadEnv();
  const brand = await findBrandById(args.brandId);
  if (!brand) throw new Error(`Brand ${args.brandId} not found`);

  const voice = brand.voiceJson;
  const voiceBlock = voice
    ? `Voice: ${voice.summary}\nTone: ${voice.tone.join(', ')}\nAudience: ${voice.audience}\nDo: ${voice.do.join('; ')}\nDon't: ${voice.dont.join('; ')}${voice.hashtags?.length ? `\nPreferred hashtags: ${voice.hashtags.join(' ')}` : ''}`
    : `Voice: (not yet captured — keep it warm, specific, and human)`;

  const userPrompt = [
    `Brand: @${brand.igHandle ?? '(unknown)'}`,
    voiceBlock,
    args.briefingHint ? `Briefing: ${args.briefingHint}` : 'Briefing: pick a fresh idea consistent with the brand.',
    'Return only the JSON object — no markdown fences.',
  ].join('\n\n');

  logger.info({ brandId: brand.id }, 'Generating post draft');

  const completion = await getOpenAI().chat.completions.create({
    model: env.OPENAI_TEXT_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message.content ?? '{}';
  let parsed: { caption?: string; imagePrompt?: string };
  try {
    parsed = JSON.parse(raw) as { caption?: string; imagePrompt?: string };
  } catch (err) {
    logger.error({ err, raw }, 'Draft JSON parse failed');
    throw new Error('Draft generator returned non-JSON');
  }
  if (!parsed.caption || !parsed.imagePrompt) {
    throw new Error('Draft generator missing caption or imagePrompt');
  }

  const image = await generateAndStoreImage({
    prompt: parsed.imagePrompt,
    size: '1024x1536',
    quality: 'medium',
    ownerId: brand.id,
  });

  return {
    caption: parsed.caption.trim(),
    imageUrl: image.url,
    imagePrompt: parsed.imagePrompt,
  };
}
