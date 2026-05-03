import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_BASE_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  KAPSO_API_KEY: z.string().min(1, 'KAPSO_API_KEY is required'),
  KAPSO_PHONE_NUMBER_ID: z.string().min(1, 'KAPSO_PHONE_NUMBER_ID is required'),
  KAPSO_BUSINESS_ACCOUNT_ID: z.string().optional(),
  KAPSO_WEBHOOK_SECRET: z.string().min(1, 'KAPSO_WEBHOOK_SECRET is required'),

  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_TEXT_MODEL: z.string().default('gpt-4.1'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  DUFFY_ORCHESTRATOR_MODEL: z.string().default('anthropic/claude-haiku-4-5'),
  ONBOARDING_AGENT_MODEL: z.string().default('anthropic/claude-sonnet-4-5'),

  // Google Generative AI (Gemini) — required when any CREATIVE_*_MODEL uses a
  // `google/...` slug (e.g. Gemini 3 for ideation/hashtags). Kept optional so
  // a dev can swap those slugs for anthropic/openai without setting it.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

  // Per-role model slugs for the creative pipeline. Each specialist sub-agent
  // picks its own model so we can optimize cost/quality per task. Mastra
  // resolves the `provider/model` prefix and routes to the bundled AI-SDK
  // provider, so swapping providers needs no code change.
  CREATIVE_DIRECTOR_MODEL: z.string().default('openai/gpt-4o'),
  // `gemini-2.5-pro` instead of `gemini-3-pro-preview` because Gemini 3 Pro
  // has no free tier (limit=0), which was hard-blocking any `/post` run on a
  // non-billable Google key. 2.5-pro is free-tier-eligible and good enough
  // for ideation / hashtag generation. Swap via env to upgrade later.
  CREATIVE_IDEATOR_MODEL: z.string().default('google/gemini-2.5-pro'),
  CREATIVE_COPYWRITER_MODEL: z.string().default('anthropic/claude-sonnet-4-6'),
  CREATIVE_HASHTAG_MODEL: z.string().default('google/gemini-2.5-pro'),
  CREATIVE_STYLIST_MODEL: z.string().default('openai/gpt-4o'),
  // Image rendering uses OPENAI_IMAGE_MODEL above.
  // The edit-intent classifier (classifyEditIntent) reuses CREATIVE_DIRECTOR_MODEL.
  // Future: CREATIVE_VIDEO_MODEL for reel rendering.

  APIFY_TOKEN: z.string().min(1, 'APIFY_TOKEN is required'),

  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET: z.string().min(1, 'R2_BUCKET is required'),
  R2_PUBLIC_BASE_URL: z.string().url(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Lazy env accessor — useful for tests/scripts that don't need every key set.
 * Throws on access if a required key is missing.
 */
export const env = new Proxy({} as Env, {
  get(_t, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
