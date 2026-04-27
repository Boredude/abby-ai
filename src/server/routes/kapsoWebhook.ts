import { Hono } from 'hono';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { tryRecordWebhookEvent } from '../../db/repositories/webhookEvents.js';
import { dispatchInboundMessage } from '../../services/inboundDispatcher.js';
import { parseKapsoEvent, verifyKapsoSignature } from '../../services/kapso/index.js';
import type { KapsoMessageReceivedEvent } from '../../services/kapso/types.js';

export const kapsoWebhookRoute = new Hono();

kapsoWebhookRoute.post('/webhooks/kapso', async (c) => {
  const env = loadEnv();

  // 1. Read RAW body BEFORE any JSON parsing — required for HMAC verification.
  const rawBody = await c.req.text();
  const signature = c.req.header('x-webhook-signature') ?? '';
  const idempotencyKey = c.req.header('x-idempotency-key');
  const eventName = c.req.header('x-webhook-event');

  if (!verifyKapsoSignature(rawBody, signature, env.KAPSO_WEBHOOK_SECRET)) {
    logger.warn({ eventName, sigPrefix: signature.slice(0, 8) }, 'Kapso webhook signature invalid');
    return c.json({ error: 'invalid_signature' }, 401);
  }

  // 2. Idempotency dedupe — Kapso retries on non-2xx; ack duplicates fast.
  if (idempotencyKey) {
    const fresh = await tryRecordWebhookEvent(idempotencyKey, 'kapso');
    if (!fresh) {
      logger.debug({ idempotencyKey }, 'Duplicate webhook, acking');
      return c.json({ ok: true, duplicate: true });
    }
  }

  // 3. Parse the body.
  let event: KapsoMessageReceivedEvent;
  try {
    event = JSON.parse(rawBody) as KapsoMessageReceivedEvent;
  } catch (err) {
    logger.error({ err }, 'Kapso webhook: invalid JSON');
    return c.json({ error: 'bad_json' }, 400);
  }

  // 4. Filter by event type (Kapso uses X-Webhook-Event header, not a body field).
  if (eventName && eventName !== 'whatsapp.message.received') {
    logger.info({ eventName }, 'Kapso webhook: ignored event type');
    return c.json({ ok: true, skipped: true, reason: 'event_type' });
  }

  // 5. Ack 200 fast and process asynchronously. Kapso retries on timeout, so we
  //    must respond quickly even if downstream (LLM, DB) is slow.
  const parsed = parseKapsoEvent(event);
  if (!parsed) {
    logger.warn(
      { eventName, msgType: event.message?.type, bodyPreview: rawBody.slice(0, 300) },
      'Kapso webhook: parse returned null',
    );
    return c.json({ ok: true, skipped: true, reason: 'unparseable' });
  }

  logger.info(
    {
      kind: parsed.kind,
      channel: parsed.channelKind,
      externalUserId: parsed.externalUserId,
      externalMessageId: parsed.externalMessageId,
    },
    'Kapso webhook: dispatching',
  );

  void dispatchInboundMessage(parsed).catch((err: unknown) => {
    logger.error({ err, parsed }, 'dispatchInboundMessage failed');
  });

  return c.json({ ok: true });
});
