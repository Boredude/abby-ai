/**
 * Vitest setup: injects stub env vars before any module evaluates `loadEnv()`.
 * Real env values are only required for runtime — the tests only need
 * `loadEnv()` to succeed.
 */

const STUBS: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  PORT: '3000',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  KAPSO_API_KEY: 'test-kapso-key',
  KAPSO_PHONE_NUMBER_ID: '0000000000',
  KAPSO_WEBHOOK_SECRET: 'whsec_test',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_TEXT_MODEL: 'gpt-4.1',
  OPENAI_IMAGE_MODEL: 'gpt-image-2',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key',
  DUFFY_ORCHESTRATOR_MODEL: 'anthropic/claude-haiku-4-5',
  ONBOARDING_AGENT_MODEL: 'anthropic/claude-sonnet-4-5',
  CREATIVE_DIRECTOR_MODEL: 'openai/gpt-4o',
  CREATIVE_IDEATOR_MODEL: 'google/gemini-2.5-pro',
  CREATIVE_COPYWRITER_MODEL: 'anthropic/claude-sonnet-4-6',
  CREATIVE_HASHTAG_MODEL: 'google/gemini-2.5-pro',
  CREATIVE_STYLIST_MODEL: 'openai/gpt-4o',
  APIFY_TOKEN: 'apify_api_test',
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET: 'duffy-test',
  R2_PUBLIC_BASE_URL: 'https://duffy-test.r2.dev',
};

for (const [key, value] of Object.entries(STUBS)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
