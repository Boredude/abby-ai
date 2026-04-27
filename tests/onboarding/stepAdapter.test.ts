import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand } from '../../src/db/schema.js';
import type { OnboardingStep, OnboardingStepResult } from '../../src/mastra/onboarding/types.js';
import { makeMockBoundChannel } from '../helpers/mockChannel.js';

const mocks = vi.hoisted(() => ({
  findBrandById: vi.fn<(id: string) => Promise<Brand | null>>(),
  requireBrandChannel: vi.fn(),
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  findBrandById: mocks.findBrandById,
}));

vi.mock('../../src/channels/registry.js', () => ({
  requireBrandChannel: mocks.requireBrandChannel,
}));

import { makeMastraStep } from '../../src/mastra/onboarding/stepAdapter.js';

const BRAND_ID = '11111111-1111-1111-1111-111111111111';

function fakeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: BRAND_ID,
    igHandle: null,
    voiceJson: null,
    cadenceJson: null,
    brandKitJson: null,
    designSystemJson: null,
    igAnalysisJson: null,
    brandBoardImageUrl: null,
    timezone: 'UTC',
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Brand;
}

function asExecute<T extends { execute?: unknown }>(step: T) {
  if (typeof (step as { execute?: unknown }).execute !== 'function') {
    throw new Error('wrapped Mastra step exposes no execute()');
  }
  return (step as unknown as { execute: (args: unknown) => Promise<unknown> }).execute;
}

describe('makeMastraStep (onboarding step adapter)', () => {
  beforeEach(() => {
    mocks.findBrandById.mockReset();
    mocks.requireBrandChannel.mockReset();
    mocks.requireBrandChannel.mockResolvedValue(makeMockBoundChannel());
  });

  it('short-circuits when isComplete(brand) returns true and there is no resumeData', async () => {
    mocks.findBrandById.mockResolvedValue(fakeBrand({ status: 'active' }));
    const innerExecute = vi.fn<() => Promise<OnboardingStepResult>>();
    const step: OnboardingStep = {
      id: 'demo',
      displayName: 'Demo',
      isComplete: () => true,
      execute: innerExecute,
    };

    const wrapper = makeMastraStep(step);
    const exec = asExecute(wrapper);
    const out = await exec({
      inputData: { brandId: BRAND_ID },
      resumeData: undefined,
      suspend: vi.fn(),
    });

    expect(out).toEqual({ brandId: BRAND_ID });
    expect(innerExecute).not.toHaveBeenCalled();
    // Idempotency check skips loading the channel — no need to bind.
    expect(mocks.requireBrandChannel).not.toHaveBeenCalled();
  });

  it('translates a thrown OnboardingStepSuspended into a Mastra suspend() call', async () => {
    mocks.findBrandById.mockResolvedValue(fakeBrand());
    const suspendSpy = vi.fn(async (_reason: unknown) => undefined);

    const step: OnboardingStep = {
      id: 'demo',
      displayName: 'Demo',
      isComplete: () => false,
      execute: async (ctx): Promise<OnboardingStepResult> => {
        ctx.suspend({ question: 'demo_q', extra: 'meta' });
        // unreachable — ctx.suspend throws — present so TS sees a typed
        // exit even though the never-returning suspend covers it at runtime.
        return { status: 'done' };
      },
    };

    const wrapper = makeMastraStep(step);
    const exec = asExecute(wrapper);
    const out = await exec({
      inputData: { brandId: BRAND_ID },
      resumeData: undefined,
      suspend: suspendSpy,
    });

    expect(out).toEqual({ brandId: BRAND_ID });
    expect(suspendSpy).toHaveBeenCalledTimes(1);
    expect(suspendSpy.mock.calls[0]?.[0]).toMatchObject({
      question: 'demo_q',
      extra: 'meta',
    });
  });

  it('returns { brandId } when the step reports done', async () => {
    mocks.findBrandById.mockResolvedValue(fakeBrand());
    const step: OnboardingStep = {
      id: 'demo',
      displayName: 'Demo',
      isComplete: () => false,
      execute: async () => ({ status: 'done' }),
    };

    const wrapper = makeMastraStep(step);
    const exec = asExecute(wrapper);
    const out = await exec({
      inputData: { brandId: BRAND_ID },
      resumeData: undefined,
      suspend: vi.fn(),
    });
    expect(out).toEqual({ brandId: BRAND_ID });
  });

  it('throws when the step reports failed', async () => {
    mocks.findBrandById.mockResolvedValue(fakeBrand());
    const step: OnboardingStep = {
      id: 'demo',
      displayName: 'Demo',
      isComplete: () => false,
      execute: async () => ({ status: 'failed', error: 'kaboom' }),
    };

    const wrapper = makeMastraStep(step);
    const exec = asExecute(wrapper);
    await expect(
      exec({
        inputData: { brandId: BRAND_ID },
        resumeData: undefined,
        suspend: vi.fn(),
      }),
    ).rejects.toThrow(/Onboarding step "demo" failed: kaboom/);
  });

  it('forwards resumeData into the inner step ctx', async () => {
    mocks.findBrandById.mockResolvedValue(fakeBrand({ igHandle: 'nike' }));
    const observed: { reply?: string } = {};
    const step: OnboardingStep = {
      id: 'demo',
      displayName: 'Demo',
      isComplete: () => false,
      execute: async (ctx) => {
        observed.reply = ctx.resumeData?.reply;
        return { status: 'done' };
      },
    };

    const wrapper = makeMastraStep(step);
    const exec = asExecute(wrapper);
    await exec({
      inputData: { brandId: BRAND_ID },
      resumeData: { reply: 'yes ship it' },
      suspend: vi.fn(),
    });
    expect(observed.reply).toBe('yes ship it');
  });

  it('throws if the brand is missing (no silent fallthrough)', async () => {
    mocks.findBrandById.mockResolvedValue(null);
    const wrapper = makeMastraStep({
      id: 'demo',
      displayName: 'Demo',
      isComplete: () => false,
      execute: async () => ({ status: 'done' }),
    });
    const exec = asExecute(wrapper);
    await expect(
      exec({
        inputData: { brandId: BRAND_ID },
        resumeData: undefined,
        suspend: vi.fn(),
      }),
    ).rejects.toThrow(/not found/);
  });
});
