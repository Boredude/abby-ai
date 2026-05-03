import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/**
 * Resolve a Mastra-style `provider/model` slug to a concrete AI SDK
 * LanguageModel instance for direct `generateText` / `generateObject` calls.
 *
 * Mastra's `Agent({ model: string })` does this internally, but a few
 * backend helpers (e.g. classifyEditIntent) call the AI SDK directly and
 * need to route themselves. Keeping the mapping here means swapping
 * CREATIVE_*_MODEL env vars across providers requires zero code changes.
 *
 * Throws on unknown or missing prefix — we never want to silently fall
 * back to the wrong provider.
 */
export function resolveModel(slug: string): LanguageModel {
  const idx = slug.indexOf('/');
  if (idx < 0) {
    throw new Error(
      `resolveModel: expected "provider/model" slug, got "${slug}". Known providers: anthropic, openai, google.`,
    );
  }
  const provider = slug.slice(0, idx);
  const modelId = slug.slice(idx + 1);
  switch (provider) {
    case 'anthropic':
      return anthropic(modelId);
    case 'openai':
      return openai(modelId);
    case 'google':
      return google(modelId);
    default:
      throw new Error(
        `resolveModel: unsupported provider "${provider}" in slug "${slug}". Known providers: anthropic, openai, google.`,
      );
  }
}
