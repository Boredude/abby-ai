import { randomUUID } from 'node:crypto';
import OpenAI, { toFile } from 'openai';
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

export type ReferenceImage = {
  bytes: Uint8Array;
  /** image/jpeg | image/png | image/webp | image/gif */
  mediaType: string;
  /** Hint label baked into the filename — e.g. "profile-pic" or "post-1". */
  label?: string;
};

export type GenerateImageOptions = {
  prompt: string;
  /** 1024x1024 | 1024x1536 (portrait) | 1536x1024 (landscape) */
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  /** "low" | "medium" | "high" — gpt-image-* quality knob */
  quality?: 'low' | 'medium' | 'high';
  /** Logical id used in the R2 object key prefix (e.g. brandId or draftId). */
  ownerId?: string;
  /**
   * Reference images to anchor the output. When provided, the call routes to
   * `images.edit` (multi-image input) instead of `images.generate`. Up to 16
   * images are accepted by `gpt-image-2`. Order matters: the prompt should
   * refer to references positionally ("reference 1 = …, references 2-N = …").
   */
  referenceImages?: ReferenceImage[];
};

/**
 * Generates an image with OpenAI's "ChatGPT Images 2" (gpt-image-2) model and
 * uploads the result to Cloudflare R2. Returns the public URL — that's what
 * we hand to WhatsApp (Kapso requires a publicly reachable URL when sending
 * media via `image.link`).
 *
 * When `referenceImages` is provided, we use `images.edit` (multi-image input)
 * so the model can anchor on the brand's actual visuals — e.g. compositing
 * the real logo from the IG profile picture into the brand board. Without
 * references we use plain text-to-image `images.generate`.
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
  const refs = opts.referenceImages ?? [];
  const mode: 'edit' | 'generate' = refs.length > 0 ? 'edit' : 'generate';

  logger.info(
    { size, quality, model: env.OPENAI_IMAGE_MODEL, mode, refCount: refs.length },
    'Generating image',
  );

  let b64: string | undefined;
  if (mode === 'edit') {
    const files = await Promise.all(
      refs.map((r, i) =>
        toFile(Buffer.from(r.bytes), `${r.label ?? `ref-${i}`}.${extOf(r.mediaType)}`, {
          type: r.mediaType,
        }),
      ),
    );
    const response = await client.images.edit({
      model: env.OPENAI_IMAGE_MODEL,
      image: files,
      prompt: opts.prompt,
      n: 1,
      size,
      quality,
    });
    b64 = response.data?.[0]?.b64_json;
  } else {
    const response = await client.images.generate({
      model: env.OPENAI_IMAGE_MODEL,
      prompt: opts.prompt,
      n: 1,
      size,
      quality,
    });
    b64 = response.data?.[0]?.b64_json;
  }

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

function extOf(mediaType: string): string {
  if (mediaType.includes('png')) return 'png';
  if (mediaType.includes('webp')) return 'webp';
  if (mediaType.includes('gif')) return 'gif';
  return 'jpg';
}
