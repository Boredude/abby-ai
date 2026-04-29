/**
 * Helpers shared by the vision-based onboarding analyzers (post-grid visuals
 * + profile-picture). Anthropic refuses to fetch URL-based images that the
 * target's robots.txt disallows, and Instagram's CDN does exactly that — so
 * we always download the bytes ourselves and send them inline.
 */

export type DownloadedImage = { bytes: Uint8Array; mediaType: string };

/**
 * Download an image and return the raw bytes + the MIME type to declare to
 * the model. Anthropic accepts jpeg/png/gif/webp; if the server doesn't tell
 * us a usable type, we fall back to image/jpeg (which is what IG's CDN
 * actually serves).
 */
export async function downloadImage(url: string): Promise<DownloadedImage> {
  const res = await fetch(url, {
    headers: {
      // IG CDN sometimes returns 403 without a browsery UA / referer.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      referer: 'https://www.instagram.com/',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching image`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const mediaType =
    ct.startsWith('image/jpeg') || ct.startsWith('image/jpg')
      ? 'image/jpeg'
      : ct.startsWith('image/png')
        ? 'image/png'
        : ct.startsWith('image/webp')
          ? 'image/webp'
          : ct.startsWith('image/gif')
            ? 'image/gif'
            : 'image/jpeg';
  return { bytes: buf, mediaType };
}

/**
 * Mastra model ids look like "anthropic/claude-sonnet-4-5"; the AI SDK's
 * `anthropic(...)` factory just wants the bare model id.
 */
export function stripGatewayPrefix(modelId: string): string {
  const idx = modelId.indexOf('/');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}
