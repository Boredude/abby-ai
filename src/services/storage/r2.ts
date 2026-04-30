import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

let client: S3Client | null = null;

/**
 * Turns an arbitrary owner identifier (IG handle, brand name, brand id) into
 * a filesystem-safe slug suitable for an R2 key segment. We bias toward
 * legibility — these end up as folders in the Cloudflare dashboard, so the
 * goal is "you can tell which brand this is at a glance".
 *
 * - lowercases
 * - strips a leading `@`
 * - collapses anything outside `[a-z0-9._-]` into `-`
 * - trims leading/trailing separators
 * - caps at 40 chars (IG handles are <=30 anyway; brand names can be long)
 *
 * Returns `null` for empty / whitespace-only input so callers can fall back.
 */
export function sanitizeOwnerSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : null;
}

/**
 * Picks the most human-readable owner segment for an R2 key. Prefers an
 * explicit slug (typically `brand.igHandle`) and falls back to the opaque
 * id only when no slug is available — this happens during the very early
 * onboarding window before we've extracted the handle.
 */
export function pickOwnerSegment(args: {
  slug?: string | null;
  fallbackId?: string | null;
}): string | null {
  const slug = sanitizeOwnerSlug(args.slug);
  if (slug) return slug;
  if (args.fallbackId && args.fallbackId.trim().length > 0) return args.fallbackId;
  return null;
}

/**
 * Cloudflare R2 is S3-compatible. We talk to it through the AWS S3 SDK
 * pointed at R2's endpoint.
 *
 * https://developers.cloudflare.com/r2/api/s3/api/
 */
function getClient(): S3Client {
  if (client) return client;
  const env = loadEnv();
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

/**
 * Uploads a buffer to R2 and returns its public URL (assuming the bucket has
 * a public custom-domain or `pub-*.r2.dev` bound to `R2_PUBLIC_BASE_URL`).
 */
export async function uploadToR2(args: {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}): Promise<{ key: string; url: string }> {
  const env = loadEnv();
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: args.key,
    Body: args.body,
    ContentType: args.contentType,
    CacheControl: args.cacheControl ?? 'public, max-age=31536000, immutable',
  });
  await getClient().send(cmd);
  const url = `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${args.key}`;
  logger.debug({ key: args.key, url }, 'Uploaded object to R2');
  return { key: args.key, url };
}
