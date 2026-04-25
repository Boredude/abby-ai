# Abby — Autonomous Instagram Content Agent

Abby is a Mastra-powered AI agent that helps brands plan, draft, and approve Instagram posts via WhatsApp. The MVP focuses on the conversational/HITL loop: brand owners chat with Abby on WhatsApp, she analyzes the brand, generates post drafts (caption + image via ChatGPT Images 2), gets the brand's approval, and at the scheduled time delivers the final post back to the brand on WhatsApp for manual posting.

## Stack

- **Runtime:** Node 22+, TypeScript (strict)
- **HTTP:** Hono (`@hono/node-server`)
- **Agent:** [Mastra](https://mastra.ai) (`@mastra/core`) with Postgres-backed storage (`@mastra/pg`)
- **DB:** Postgres (Neon) via Drizzle ORM
- **Jobs:** `pg-boss` (cron + one-shot deliveries) on the same Postgres
- **WhatsApp:** [Kapso](https://kapso.ai) Meta-proxy WhatsApp API
- **AI:** OpenAI — text + ChatGPT Images 2 (`gpt-image-2`) via `@ai-sdk/openai`
- **Media:** Cloudflare R2 (S3-compatible) for public image URLs

## Quickstart

```bash
pnpm install
cp .env.example .env       # fill in secrets
pnpm db:generate           # generate migrations
pnpm db:migrate            # apply migrations
pnpm dev                   # start the agent + HTTP server
```

Expose your local server publicly (e.g. with `cloudflared` or `ngrok`) and register the URL with Kapso so inbound WhatsApp messages reach `/webhooks/kapso`.

## Project layout

```
src/
  config/          # env + logger
  db/              # Drizzle schema + client + migrations
  services/        # external clients (Kapso, OpenAI, R2 storage)
  mastra/
    agents/        # Abby agent
    tools/         # Mastra tools the agent + workflows call
    workflows/     # brandOnboarding, postDraftApproval, weeklyPlanning
    index.ts       # Mastra instance
  server/          # Hono routes (webhooks, health)
  jobs/            # pg-boss workers (deliverApprovedPost, weeklyPlanning, reminders)
  index.ts         # entrypoint
```

## Deploy

Deploy targets: Railway / Render / Fly. Build via the included `Dockerfile`.

Required services:
- **Neon Postgres** (Drizzle schema + Mastra storage + pg-boss queues all share one DB).
- **Cloudflare R2** bucket with a public custom domain (or `pub-*.r2.dev` URL) bound to `R2_PUBLIC_BASE_URL` — Kapso media `image.link` requires a publicly reachable URL.
- **OpenAI** API key (`gpt-4.1` text + `gpt-image-2`).
- **Kapso** workspace + sandbox WhatsApp number; register the deployed `/webhooks/kapso` URL and supply the webhook signing secret.

Post-deploy checklist:
1. Run migrations: `pnpm db:migrate` against the production `DATABASE_URL`.
2. Register the webhook URL in Kapso's dashboard. Send yourself a test WhatsApp message to verify HMAC + dispatch.
3. Hit `/health` to confirm the service is up.
4. Wait for Monday 09:00 UTC or manually enqueue: `boss.send('abby.weekly-planning', {})` to fan out drafts.

## Status

MVP. See [`/Users/omribitan/.cursor/plans/abby_ig_agent_mvp_090ad94c.plan.md`](.) for the build plan.
