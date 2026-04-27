import { describe, expect, it } from 'vitest';
import { brandWorkingMemorySchema, memoryFor } from '../../src/mastra/memory.js';

describe('shared per-brand memory wiring', () => {
  it('memoryFor produces a stable thread + resource per brand', () => {
    expect(memoryFor('brand-1')).toEqual({ thread: 'brand:brand-1', resource: 'brand-1' });
    // Different brands map to different threads (no leakage).
    expect(memoryFor('brand-2')).toEqual({ thread: 'brand:brand-2', resource: 'brand-2' });
  });

  it('working-memory schema accepts the structured fields the agents are instructed to write', () => {
    const sample = {
      activeOnboardingStepId: 'brand_kit',
      recentIntent: 'user wants to lighten the palette',
      lastReviewArtifact: {
        kind: 'brand_kit' as const,
        summary: 'brand board v2 with terracotta palette',
        imageUrl: 'https://example.com/board.png',
      },
      channelPreference: {
        primaryKind: 'whatsapp' as const,
        notes: 'prefers mornings',
      },
    };
    expect(() => brandWorkingMemorySchema.parse(sample)).not.toThrow();
  });

  it('working-memory schema accepts a sparsely-populated blob (everything optional)', () => {
    expect(() => brandWorkingMemorySchema.parse({})).not.toThrow();
    expect(() => brandWorkingMemorySchema.parse({ activeOnboardingStepId: null })).not.toThrow();
    expect(() =>
      brandWorkingMemorySchema.parse({ recentIntent: 'check on me Friday' }),
    ).not.toThrow();
  });

  it('rejects shapes that violate the schema (caps, enum)', () => {
    expect(() =>
      brandWorkingMemorySchema.parse({ recentIntent: 'x'.repeat(500) }),
    ).toThrow();
    expect(() =>
      brandWorkingMemorySchema.parse({
        channelPreference: { primaryKind: 'fax' as unknown as 'whatsapp' },
      }),
    ).toThrow();
  });
});
