import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { uploadToR2 } from '../storage/r2.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (openai) return openai;
  const env = loadEnv();
  openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openai;
}

export type GenerateImageOptions = {
  prompt: string;
  /** 1024x1024 | 1024x1536 (portrait) | 1536x1024 (landscape) */
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  /** "low" | "medium" | "high" — gpt-image-* quality knob */
  quality?: 'low' | 'medium' | 'high';
  /** Logical id used in the R2 object key prefix (e.g. brandId or draftId). */
  ownerId?: string;
};

/**
 * Generates an image with OpenAI's "ChatGPT Images 2" (gpt-image-2) model and
 * uploads the result to Cloudflare R2. Returns the public URL — that's what
 * we hand to WhatsApp (Kapso requires a publicly reachable URL when sending
 * media via `image.link`).
 */
export async function generateAndStoreImage(opts: GenerateImageOptions): Promise<{
  url: string;
  key: string;
  prompt: string;
}> {
  const env = loadEnv();
  const client = getOpenAI();
  const size = opts.size ?? '1024x1024';
  const quality = opts.quality ?? 'medium';

  logger.info({ size, quality, model: env.OPENAI_IMAGE_MODEL }, 'Generating image');

  const response = await client.images.generate({
    model: env.OPENAI_IMAGE_MODEL,
    prompt: opts.prompt,
    n: 1,
    size,
    quality,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('OpenAI image response did not include b64_json');
  }
  const buffer = Buffer.from(b64, 'base64');

  const ownerSeg = opts.ownerId ? `${opts.ownerId}/` : '';
  const key = `images/${ownerSeg}${Date.now()}-${randomUUID()}.png`;

  const { url } = await uploadToR2({
    key,
    body: buffer,
    contentType: 'image/png',
  });

  return { url, key, prompt: opts.prompt };
}
