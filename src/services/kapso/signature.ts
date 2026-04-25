import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Kapso webhook signature.
 *
 * Per Kapso docs: HMAC-SHA256 over the **raw** JSON request body using your
 * webhook secret, hex-encoded, supplied in the `X-Webhook-Signature` header.
 * Comparison MUST be timing-safe.
 *
 * https://docs.kapso.ai/docs/platform/webhooks/security
 */
export function verifyKapsoSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Both must be the same length for timingSafeEqual.
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}
