import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const generateObjectMock = vi.fn();

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: (id: string) => ({ id }),
}));

import { classifyReviewIntent } from '../../src/services/onboarding/classifyReviewIntent.js';

describe('classifyReviewIntent', () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns approve when LLM says approve', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { intent: 'approve', handle: null, editSummary: null, reasoning: 'they said yes' },
    });
    const result = await classifyReviewIntent('ya looks about right');
    expect(result).toEqual({ intent: 'approve' });
  });

  it('returns new_handle with normalized handle', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { intent: 'new_handle', handle: '@Nike', editSummary: null, reasoning: 'new handle' },
    });
    const result = await classifyReviewIntent("let's try @Nike");
    expect(result).toEqual({ intent: 'new_handle', handle: 'nike' });
  });

  it('downgrades new_handle to unclear when handle is missing', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { intent: 'new_handle', handle: null, editSummary: null, reasoning: 'oops' },
    });
    const result = await classifyReviewIntent('try a different one');
    expect(result).toEqual({ intent: 'unclear' });
  });

  it('downgrades new_handle to unclear when handle fails normalization', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        intent: 'new_handle',
        handle: 'this is not a username!!',
        editSummary: null,
        reasoning: 'bad parse',
      },
    });
    const result = await classifyReviewIntent('try the one I just said');
    expect(result).toEqual({ intent: 'unclear' });
  });

  it('returns edit with the LLM-provided summary', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        intent: 'edit',
        handle: null,
        editSummary: 'swap green for navy',
        reasoning: 'palette tweak',
      },
    });
    const result = await classifyReviewIntent('change the green to navy please');
    expect(result).toEqual({ intent: 'edit', editSummary: 'swap green for navy' });
  });

  it('falls back to the raw reply when edit summary is empty', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { intent: 'edit', handle: null, editSummary: '', reasoning: 'no summary' },
    });
    const result = await classifyReviewIntent('more playful');
    expect(result).toEqual({ intent: 'edit', editSummary: 'more playful' });
  });

  it('returns unclear when LLM says unclear', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { intent: 'unclear', handle: null, editSummary: null, reasoning: 'small talk' },
    });
    const result = await classifyReviewIntent('hi there');
    expect(result).toEqual({ intent: 'unclear' });
  });

  it('returns unclear without calling LLM on empty reply', async () => {
    const result = await classifyReviewIntent('   ');
    expect(result).toEqual({ intent: 'unclear' });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it('falls back to isExplicitApproval (approve) when LLM throws', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('rate limited'));
    const result = await classifyReviewIntent('yes lock it in');
    expect(result).toEqual({ intent: 'approve' });
  });

  it('falls back to unclear when LLM throws and reply is not an obvious approval', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('rate limited'));
    const result = await classifyReviewIntent('change the palette');
    expect(result).toEqual({ intent: 'unclear' });
  });

  it('passes the current handle to the LLM for context', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { intent: 'approve', handle: null, editSummary: null, reasoning: 'approved' },
    });
    await classifyReviewIntent('yep', { currentHandle: 'ob.cocktails' });
    const args = generateObjectMock.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    expect(args.messages[0]?.content).toContain('@ob.cocktails');
    expect(args.messages[0]?.content).toContain('"yep"');
  });
});
