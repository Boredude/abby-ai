# Abby — Autonomous Instagram Content Agent

Abby is a Mastra-powered AI agent that plans, drafts, and ships Instagram content for brands — entirely over WhatsApp. No dashboards, no logins. The brand owner chats with Abby like they would with a content manager. Abby analyzes the brand, generates posts (caption + AI image), gets approval via interactive WhatsApp buttons, and at the scheduled time delivers the final asset back for the brand to post.

> **MVP scope:** Abby produces approved posts and DMs them back to the brand on WhatsApp for manual posting. Direct publishing to Instagram is intentionally out of scope for v1.

---

## Try Abby

Scan the QR with your phone to start a WhatsApp conversation with Abby and walk through onboarding.

<p align="center">
  <img src="docs/abby-qr.png" alt="Scan to message Abby on WhatsApp" width="240" />
</p>

When you message her she'll ask for your Instagram handle, brand description, posting cadence, and timezone. From there she takes over.

---

## How it works

```
WhatsApp ──▶ Kapso ──▶ /webhooks/kapso ──▶ inboundDispatcher
                                              │
                       ┌──────────────────────┼──────────────────────┐
                       ▼                      ▼                      ▼
              brandOnboarding (WF)   postDraftApproval (WF)   abby agent (chat)
                       │                      │
                       ▼                      ▼
                 brands table          post_drafts table
                                              │
                                              ▼
                                    pg-boss deliver job
                                              │
                                              ▼
                                    WhatsApp delivery
```

- **Mastra workflows** (`brandOnboarding`, `postDraftApproval`) hold conversational state across WhatsApp turns using `suspend()` / `resume()`.
- **`pg-boss`** runs the weekly planning cron, the approval-reminder cron, and one-shot delivery jobs at each post's `scheduled_at`.
- **Cloudflare R2** stores generated images and exposes them via a public URL — required because WhatsApp's media `image.link` must be fetchable.
- **HMAC-verified webhooks** via Kapso's `X-Webhook-Signature` header on the raw request body.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22+, TypeScript strict |
| Agent framework | [Mastra](https://mastra.ai) (`@mastra/core`) |
| HTTP | Hono (`@hono/node-server`) |
| Database | Neon Postgres + Drizzle ORM |
| Jobs | `pg-boss` (same Postgres) |
| Agent storage | `@mastra/pg` (same Postgres) |
| WhatsApp | [Kapso](https://kapso.ai) (Meta Cloud API proxy) |
| Text AI | OpenAI `gpt-4.1` via `@ai-sdk/openai` |
| Image AI | OpenAI `gpt-image-2` (ChatGPT Images 2) |
| Media storage | Cloudflare R2 (S3-compatible) |
| Tests | Vitest |

## Local development

Prerequisites: Node 22+, pnpm, and accounts at Kapso, OpenAI, Neon, and Cloudflare.

```bash
pnpm install
cp .env.example .env             # fill in secrets — see below
pnpm db:migrate                  # apply Drizzle migrations
pnpm dev                         # start the server (http://localhost:3000)
```

Then expose `localhost:3000` publicly so Kapso can reach the webhook:

```bash
cloudflared tunnel --url http://localhost:3000
```

Register the resulting `https://<tunnel>.trycloudflare.com/webhooks/kapso` URL in the Kapso dashboard with the `whatsapp.message.received` event subscribed and **batching disabled**.

### Required env vars

Set in `.env`:

```ini
# App
PUBLIC_BASE_URL=https://<your-tunnel>.trycloudflare.com

# Database (Neon)
DATABASE_URL=postgresql://...

# Kapso (WhatsApp)
KAPSO_API_KEY=...
KAPSO_PHONE_NUMBER_ID=...
KAPSO_BUSINESS_ACCOUNT_ID=...
KAPSO_WEBHOOK_SECRET=...

# OpenAI
OPENAI_API_KEY=sk-...

# Cloudflare R2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=abby-ai-mvp
R2_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev
```

See [`.env.example`](.env.example) for the full list.

### Useful commands

```bash
pnpm dev               # tsx watch
pnpm test              # vitest
pnpm lint              # eslint
pnpm db:generate       # diff schema → new migration
pnpm db:migrate        # apply pending migrations
pnpm build             # tsc to dist/
```

## Project layout

```
src/
  config/          env + logger
  db/              Drizzle schema, client, migrations, repositories
  services/
    kapso/         Kapso client + webhook signature + inbound parser
    storage/       Cloudflare R2 upload
    media/         OpenAI image generation
    inboundDispatcher.ts
    workflowRunner.ts
  mastra/
    agents/        Abby agent (system prompt + tools)
    tools/         getBrandProfile, updateBrandProfile, generateImage
    workflows/     brandOnboarding, postDraftApproval
    index.ts       Mastra instance
  server/          Hono routes (/health, /webhooks/kapso)
  jobs/            pg-boss workers (delivery, weekly planning, reminders)
  index.ts         entrypoint

drizzle/           generated migrations (committed)
tests/             vitest unit + scenario tests
```

## Deploy

Build the included `Dockerfile` and deploy to Railway, Render, or Fly. The same Neon Postgres backs Drizzle, Mastra storage, and pg-boss — no other state stores required.

Post-deploy:

1. Run `pnpm db:migrate` against the production `DATABASE_URL`.
2. Update Kapso's webhook URL to the production `/webhooks/kapso`.
3. `GET /health` to confirm the service is up.
4. Send a WhatsApp message to your Kapso number to verify end-to-end.

## License

MIT.
