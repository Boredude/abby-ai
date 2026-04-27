import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';

/**
 * Shared per-brand memory.
 *
 * All agents (Duffy + sub-agents) read from and write to a SINGLE Mastra
 * `Memory` instance backed by Postgres. Every brand has one thread keyed
 * `brand:<brandId>` so that delegating from Duffy → onboardingAgent (or any
 * other sub-agent) keeps the conversation continuous from the brand's
 * perspective. A single resourceId per brand also lets us reset all of a
 * brand's history with one cascade.
 *
 * On top of message history, we enable Mastra's structured working memory
 * (resource-scoped, schema-validated) so the supervisor and sub-agents
 * share a small, stable scratchpad about each brand: what step the user is
 * on, what we last asked them, and what artifact (kit, draft) is on screen.
 * This is the persistent multi-tenant context layer Phase 4 calls for.
 */

/**
 * Schema for the per-brand working-memory blob. Kept narrow on purpose —
 * working memory is in the LLM's context window every turn, so anything
 * verbose or quickly-changing belongs in the regular message history or
 * the brand DB row, not here.
 */
export const brandWorkingMemorySchema = z.object({
  /** Stable id of the onboarding step the brand is currently on (e.g. `'brand_kit'`). */
  activeOnboardingStepId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Stable id of the onboarding step in progress (matches OnboardingStep.id). Null/undefined when onboarding is complete or not yet started.",
    ),
  /**
   * Short, plain-language summary of what the user most recently asked for
   * or signalled. Useful for Duffy to pick up multi-turn intents that
   * predate the latest message (e.g. "user asked to lighten the palette").
   */
  recentIntent: z
    .string()
    .max(280)
    .nullable()
    .optional()
    .describe(
      "One-line summary of the user's most recent intent or ask (max 280 chars). Update when the user states a new goal or changes direction.",
    ),
  /** Artifact (image / kit / draft) currently being reviewed by the user, if any. */
  lastReviewArtifact: z
    .object({
      kind: z
        .enum(['brand_kit', 'post_draft', 'cadence_summary', 'other'])
        .describe('Type of artifact most recently sent for review.'),
      summary: z
        .string()
        .max(280)
        .describe('One-line description of the artifact (e.g. "brand board v2 with terracotta palette").'),
      imageUrl: z.string().optional().describe('Optional: URL of the most recent image artifact.'),
    })
    .nullable()
    .optional()
    .describe(
      'The artifact the user is currently reviewing. Set when sending something for review; clear (set to null) once the user approves or moves on.',
    ),
  /** Per-brand channel preference hint. */
  channelPreference: z
    .object({
      primaryKind: z
        .enum(['whatsapp', 'sms', 'telegram', 'instagram', 'tiktok'])
        .optional()
        .describe('Preferred channel kind for proactive outreach.'),
      notes: z.string().max(140).optional().describe('Free-form preference notes (max 140 chars).'),
    })
    .nullable()
    .optional()
    .describe('Optional channel preference signals captured from the user.'),
});

export type BrandWorkingMemory = z.infer<typeof brandWorkingMemorySchema>;

let storage: PostgresStore | null = null;
let memory: Memory | null = null;

function getStorage(): PostgresStore {
  if (storage) return storage;
  const env = loadEnv();
  storage = new PostgresStore({
    id: 'duffy-memory-storage',
    connectionString: env.DATABASE_URL,
  });
  return storage;
}

export function getSharedMemory(): Memory {
  if (memory) return memory;
  memory = new Memory({
    storage: getStorage(),
    options: {
      workingMemory: {
        enabled: true,
        // Resource-scoped: working memory is tied to the brand (resourceId),
        // not to any single thread. If we ever spawn additional threads per
        // brand (e.g. a separate "post-draft review" thread), they'll all
        // see the same working-memory blob.
        scope: 'resource',
        schema: brandWorkingMemorySchema,
      },
    },
  });
  return memory;
}

/**
 * Per-brand memory thread + resource convention. Pass to `agent.generate(..., { memory: memoryFor(brandId) })`.
 */
export function memoryFor(brandId: string): { thread: string; resource: string } {
  return { thread: `brand:${brandId}`, resource: brandId };
}

/** Test-only: drops the cached singletons so a fresh module mock takes effect. */
export function _resetMemoryForTests(): void {
  storage = null;
  memory = null;
}
