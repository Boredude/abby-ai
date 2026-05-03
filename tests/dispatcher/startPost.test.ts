import { describe, expect, it, vi } from 'vitest';
import { makeMockBoundChannel } from '../helpers/mockChannel.js';

// The workflow's `startWorkflow` import is static, so we mock it before
// importing the workflow module.
const bound = makeMockBoundChannel('15550001111');

vi.mock('../../src/channels/registry.js', () => ({
  requireBrandChannel: vi.fn(async () => bound),
}));

const mocks = vi.hoisted(() => {
  type Args = {
    workflowId: string;
    brandId: string;
    inputData: { brandId: string; scheduledAt: string; briefingHint?: string };
  };
  type Result = { runId: string; status: string };
  return {
    startWorkflow: vi.fn<(args: Args) => Promise<Result>>(async () => ({
      runId: 'approval-run-1',
      status: 'suspended',
    })),
  };
});

vi.mock('../../src/services/workflowRunner.js', () => ({
  startWorkflow: mocks.startWorkflow,
  resumeWorkflow: vi.fn(),
}));

// The workflow imports Mastra packages at module load — stub them to avoid
// hitting real DBs.
vi.mock('@mastra/pg', () => ({
  PostgresStore: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@mastra/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({})),
}));

import { startPostWorkflow } from '../../src/mastra/workflows/startPost.js';

/**
 * Each Mastra step has its `execute` attached on the step object. Asserting
 * on the step's behavior directly (instead of running a full Mastra run)
 * keeps these tests fast and avoids pulling in the Postgres-backed
 * storage layer.
 */
function getStep(id: string) {
  const steps = (startPostWorkflow as unknown as { stepDefs?: Record<string, unknown> }).stepDefs;
  // Mastra's internal layout: steps live under `.steps` or `.stepDefs` depending
  // on version. We look them up generically and fall back to a scan.
  const wf = startPostWorkflow as unknown as Record<string, unknown>;
  if (steps && (steps as Record<string, unknown>)[id]) return (steps as Record<string, unknown>)[id];
  for (const key of Object.keys(wf)) {
    const val = wf[key] as unknown;
    if (
      val &&
      typeof val === 'object' &&
      (val as { id?: string }).id === id &&
      typeof (val as { execute?: unknown }).execute === 'function'
    ) {
      return val;
    }
  }
  // Last resort: search nested properties.
  const queue: unknown[] = [wf];
  const seen = new Set<unknown>();
  while (queue.length) {
    const cur = queue.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const entry = cur as Record<string, unknown>;
    if (entry.id === id && typeof entry.execute === 'function') return entry;
    for (const v of Object.values(entry)) queue.push(v);
  }
  throw new Error(`step ${id} not found in workflow`);
}

type StepContext = {
  inputData: Record<string, unknown>;
  resumeData?: Record<string, unknown>;
  suspend: (payload: unknown) => Promise<void>;
};
type StepLike = { execute: (ctx: StepContext) => Promise<unknown> };

describe('startPost workflow: collect-brief step', () => {
  it('passes through when briefingHint is already provided', async () => {
    const step = getStep('collect-brief') as StepLike;
    const suspend = vi.fn();
    bound.sendText.mockClear();

    const out = await step.execute({
      inputData: { brandId: 'brand-1', briefingHint: 'summer menu' },
      suspend,
    });

    expect(out).toEqual({ brandId: 'brand-1', briefingHint: 'summer menu' });
    expect(bound.sendText).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('asks for a brief and suspends when none is provided', async () => {
    const step = getStep('collect-brief') as StepLike;
    const suspend = vi.fn();
    bound.sendText.mockClear();

    await step.execute({
      inputData: { brandId: 'brand-1' },
      suspend,
    });

    const sent = bound.sendText.mock.calls[0]?.[0] as string;
    expect(sent).toMatch(/what should this post be about/i);
    expect(suspend).toHaveBeenCalledWith({ awaiting: 'post_brief' });
  });

  it('treats "any" on resume as no hint', async () => {
    const step = getStep('collect-brief') as StepLike;
    const suspend = vi.fn();

    const out = await step.execute({
      inputData: { brandId: 'brand-1' },
      resumeData: { reply: 'any' },
      suspend,
    });
    expect(out).toEqual({ brandId: 'brand-1' });
  });

  it("uses the user's reply as the briefingHint", async () => {
    const step = getStep('collect-brief') as StepLike;
    const suspend = vi.fn();

    const out = await step.execute({
      inputData: { brandId: 'brand-1' },
      resumeData: { reply: '  our new matcha spritz  ' },
      suspend,
    });
    expect(out).toEqual({ brandId: 'brand-1', briefingHint: 'our new matcha spritz' });
  });
});

describe('startPost workflow: kickoff-approval step', () => {
  it('starts postDraftApproval with the brief and a future scheduledAt', async () => {
    const step = getStep('kickoff-approval') as StepLike;
    mocks.startWorkflow.mockClear();

    const before = Date.now();
    const out = (await step.execute({
      inputData: { brandId: 'brand-1', briefingHint: 'summer menu' },
      suspend: vi.fn(),
    })) as { brandId: string; approvalRunId: string };

    expect(out).toEqual({ brandId: 'brand-1', approvalRunId: 'approval-run-1' });
    const call = mocks.startWorkflow.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call!.workflowId).toBe('postDraftApproval');
    expect(call!.brandId).toBe('brand-1');
    expect(call!.inputData.briefingHint).toBe('summer menu');
    const scheduled = new Date(call!.inputData.scheduledAt).getTime();
    expect(scheduled).toBeGreaterThan(before);
  });

  it('omits briefingHint when the collect-brief step produced none', async () => {
    const step = getStep('kickoff-approval') as StepLike;
    mocks.startWorkflow.mockClear();

    await step.execute({
      inputData: { brandId: 'brand-1' },
      suspend: vi.fn(),
    });
    const call = mocks.startWorkflow.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call!.inputData.briefingHint).toBeUndefined();
  });
});
