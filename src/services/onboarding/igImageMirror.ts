import { createHash } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { pickOwnerSegment, uploadToR2 } from '../storage/r2.js';
import { downloadImage, type DownloadedImage } from './visionImage.js';

/**
 * Mirrors Instagram CDN images into R2 so the brand row stops carrying
 * time-limited URLs that rotate / expire / 403 a few minutes after the
 * scrape. We use this for the profile picture and the post grid images so
 * the later brand-board generation step (which downloads them again, this
 * time to feed gpt-image-2 as references) reads from a stable origin.
 *
 * Keys are content-addressed by `sha256(originalUrl)` — same source URL maps
 * to the same R2 key, which makes mirroring naturally idempotent across
 * retries and re-runs of the analyze step. We do *not* fold image bytes into
 * the hash: the IG CDN sometimes serves slightly different bytes for the
 * same logical asset (varying quality knobs in the URL params), and we want
 * the mirrored URL to be stable per original URL, not per byte payload.
 */

export type MirroredImage = {
  /** Original Instagram CDN URL we mirrored from. */
  originalUrl: string;
  /** Public R2 URL of the mirrored copy. Use this everywhere downstream. */
  url: string;
  /** R2 object key (within the configured bucket). */
  key: string;
  mediaType: string;
};

export type MirrorImageInput = {
  /** Logical label baked into the R2 key for human-readable debugging. */
  label: string;
  url: string;
};

/**
 * Owner identifiers used to build a human-readable R2 key segment. We prefer
 * the IG handle (the dashboard then shows folders like `ig-mirror/cocktailshq/`)
 * and fall back to the opaque brand id when a handle isn't available yet.
 */
export type MirrorOwner = {
  brandId: string;
  igHandle?: string | null;
};

const KEY_PREFIX = 'ig-mirror';

function extOf(mediaType: string): string {
  if (mediaType.includes('png')) return 'png';
  if (mediaType.includes('webp')) return 'webp';
  if (mediaType.includes('gif')) return 'gif';
  return 'jpg';
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'image';
}

function r2KeyFor(owner: MirrorOwner, label: string, originalUrl: string, mediaType: string): string {
  const sha = createHash('sha256').update(originalUrl).digest('hex').slice(0, 16);
  const ownerSeg =
    pickOwnerSegment({ slug: owner.igHandle, fallbackId: owner.brandId }) ?? owner.brandId;
  return `${KEY_PREFIX}/${ownerSeg}/${sanitizeLabel(label)}-${sha}.${extOf(mediaType)}`;
}

/**
 * Mirror a single (label, url) pair into R2. Returns null if the source
 * download fails — callers should treat that as "this image is unavailable
 * for now" and fall back to the original URL or skip it.
 */
export async function mirrorIgImage(
  owner: MirrorOwner,
  input: MirrorImageInput,
): Promise<MirroredImage | null> {
  const log = logger.child({
    brandId: owner.brandId,
    igHandle: owner.igHandle ?? undefined,
    mirror: 'ig-image',
    label: input.label,
  });
  let img: DownloadedImage;
  try {
    img = await downloadImage(input.url);
  } catch (err) {
    log.warn({ err, url: input.url }, 'IG image mirror: download failed');
    return null;
  }
  const key = r2KeyFor(owner, input.label, input.url, img.mediaType);
  try {
    const { url } = await uploadToR2({
      key,
      body: Buffer.from(img.bytes),
      contentType: img.mediaType,
    });
    return { originalUrl: input.url, url, key, mediaType: img.mediaType };
  } catch (err) {
    log.warn({ err, key }, 'IG image mirror: R2 upload failed');
    return null;
  }
}

/**
 * Mirror many IG images in parallel. Inputs whose download or upload fails
 * are simply omitted from the returned map (best-effort), so callers can
 * spread the result over an array of original URLs and keep the originals
 * for any entries that didn't make it across.
 *
 * Returned map is keyed by the *original* URL — the caller already has
 * those handy from the scraper, and looking them up is cheaper than
 * matching on label.
 */
export async function mirrorIgImages(
  owner: MirrorOwner,
  inputs: MirrorImageInput[],
): Promise<Map<string, MirroredImage>> {
  const log = logger.child({
    brandId: owner.brandId,
    igHandle: owner.igHandle ?? undefined,
    mirror: 'ig-images',
  });
  const out = new Map<string, MirroredImage>();
  if (inputs.length === 0) return out;
  const started = Date.now();
  const results = await Promise.all(inputs.map((i) => mirrorIgImage(owner, i)));
  for (const r of results) {
    if (r) out.set(r.originalUrl, r);
  }
  log.info(
    { requested: inputs.length, mirrored: out.size, elapsedMs: Date.now() - started },
    'Mirrored IG images to R2',
  );
  return out;
}
