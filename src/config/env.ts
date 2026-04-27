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

  APIFY_TOKEN: z.string().min(1, 'APIFY_TOKEN is required'),

  // ---- Instagram Playwright grid-capture (feature-flagged) ----
  // When false, the brand-analysis pipeline behaves exactly as today: visual
  // analysis runs against Apify post images. When true, we additionally run a
  // headless Chromium logged in as Duffy's IG account to screenshot the
  // brand's grid in viewport-sized chunks; the visual analyzer consumes those
  // screenshots, with the Apify post-images path used as a fallback.
  IG_GRID_CAPTURE_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Bootstrap-only credentials. The runtime never logs in unattended; these
  // are consumed by `src/scripts/bootstrapIgSession.ts` once to seed an
  // `ig_sessions` row, then production reuses the persisted storageState.
  IG_DUFFY_USERNAME: z.string().optional(),
  IG_DUFFY_PASSWORD: z.string().optional(),
  IG_GRID_TARGET_POSTS: z.coerce.number().int().positive().default(120),
  IG_GRID_VIEWPORT_WIDTH: z.coerce.number().int().positive().default(1280),
  IG_GRID_VIEWPORT_HEIGHT: z.coerce.number().int().positive().default(1600),
  IG_GRID_MAX_SCROLLS: z.coerce.number().int().positive().default(15),
  IG_GRID_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

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
