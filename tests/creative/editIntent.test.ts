import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn<
    (..._args: unknown[]) => Promise<{ object: { invalidate: string[]; reasoning: string } }>
  >(async () => ({ object: { invalidate: ['ideation'], reasoning: '' } })),
}));

vi.mock('ai', () => ({
  generateObject: mocks.generateObject,
}));
vi.mock('../../src/services/creative/modelResolver.js', () => ({
  resolveModel: (slug: string) => ({ slug }),
}));

import {
  buildEditDirective,
  classifyEditIntent,
} from '../../src/services/creative/editIntent.js';

const ALL_STEPS = ['ideation', 'copy', 'hashtags', 'artDirection', 'image'] as const;

describe('classifyEditIntent', () => {
  it('reboots from ideation on an empty note (no LLM call)', async () => {
    const out = await classifyEditIntent({ note: '', availableSteps: ALL_STEPS });
    expect(out.invalidate).toEqual(['ideation']);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it('returns what the LLM said when the output is valid', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: { invalidate: ['image'], reasoning: 'user asked for a different photo' },
    });
    const out = await classifyEditIntent({
      note: 'the caption is great, just give me another photo',
      availableSteps: ALL_STEPS,
    });
    expect(out.invalidate).toEqual(['image']);
  });

  it('filters out step ids the LLM hallucinated', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: {
        // Passed unchecked to the filtering layer — the service trims these
        // to the availableSteps whitelist.
        invalidate: ['copy', 'fonts'] as unknown as string[],
        reasoning: 'made-up',
      },
    });
    const out = await classifyEditIntent({
      note: 'rewrite the caption',
      availableSteps: ALL_STEPS,
    });
    expect(out.invalidate).toEqual(['copy']);
  });

  it('falls back to regex when the LLM call throws', async () => {
    mocks.generateObject.mockRejectedValueOnce(new Error('boom'));
    const out = await classifyEditIntent({
      note: 'give me a new image please',
      availableSteps: ALL_STEPS,
    });
    expect(out.invalidate).toEqual(['image']);
    expect(out.reasoning).toMatch(/fallback/);
  });

  it('regex fallback picks ideation for vague notes', async () => {
    mocks.generateObject.mockRejectedValueOnce(new Error('boom'));
    const out = await classifyEditIntent({
      note: 'meh',
      availableSteps: ALL_STEPS,
    });
    expect(out.invalidate).toEqual(['ideation']);
  });
});

describe('buildEditDirective', () => {
  it('composes a directive from the note + intent', () => {
    const directive = buildEditDirective('swap the photo', {
      invalidate: ['image'],
      reasoning: 'x',
    });
    expect(directive).toEqual({ note: 'swap the photo', invalidate: ['image'] });
  });
});
