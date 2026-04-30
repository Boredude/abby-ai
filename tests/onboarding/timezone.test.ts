import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand, BrandChannel } from '../../src/db/schema.js';
import {
  OnboardingStepSuspended,
  type OnboardingStepContext,
  type SuspendReason,
} from '../../src/mastra/onboarding/types.js';
import { makeMockBoundChannel } from '../helpers/mockChannel.js';

const mocks = vi.hoisted(() => ({
  findBrandById: vi.fn(),
  updateBrand: vi.fn(),
  findPrimaryChannelForBrand: vi.fn(),
  phraseAsDuffy: vi.fn(async (params: { fallback: string }) => params.fallback),
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  findBrandById: mocks.findBrandById,
  updateBrand: mocks.updateBrand,
}));

vi.mock('../../src/db/repositories/brandChannels.js', () => ({
  findPrimaryChannelForBrand: mocks.findPrimaryChannelForBrand,
}));

vi.mock('../../src/mastra/agents/voice.js', () => ({
  phraseAsDuffy: mocks.phraseAsDuffy,
}));

import { timezoneStep } from '../../src/mastra/onboarding/steps/timezone.js';

const BRAND_ID = '11111111-1111-1111-1111-111111111111';

function fakeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: BRAND_ID,
    igHandle: 'ob.cocktails',
    voiceJson: null,
    cadenceJson: null,
    brandKitJson: null,
    designSystemJson: null,
    igAnalysisJson: null,
    brandBoardImageUrl: null,
    timezone: 'UTC',
    status: 'onboarding',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Brand;
}

function fakeChannel(externalId: string): BrandChannel {
  return {
    id: 'c1',
    brandId: BRAND_ID,
    kind: 'whatsapp',
    externalId,
    isPrimary: true,
    status: 'connected',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as BrandChannel;
}

function makeCtx(args: {
  resumeReply?: string;
  externalUserId?: string;
}): OnboardingStepContext {
  const channel = makeMockBoundChannel(args.externalUserId ?? '972501234567');
  const suspend = (reason: SuspendReason): never => {
    throw new OnboardingStepSuspended(reason);
  };
  return {
    brandId: BRAND_ID,
    brand: fakeBrand(),
    channel,
    resumeData: args.resumeReply !== undefined ? { reply: args.resumeReply } : undefined,
    suspend,
  };
}

describe('timezoneStep', () => {
  beforeEach(() => {
    mocks.findBrandById.mockReset();
    mocks.updateBrand.mockReset();
    mocks.findPrimaryChannelForBrand.mockReset();
    mocks.phraseAsDuffy.mockReset();
    mocks.phraseAsDuffy.mockImplementation(async (p: { fallback: string }) => p.fallback);
  });

  it('initial run: infers from phone, asks naturally, suspends without writing', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('972501234567'));
    const ctx = makeCtx({});

    await expect(timezoneStep.execute(ctx)).rejects.toBeInstanceOf(OnboardingStepSuspended);

    expect(mocks.phraseAsDuffy).toHaveBeenCalledTimes(1);
    const call = mocks.phraseAsDuffy.mock.calls[0]?.[0] as
      | { mustConvey: string; fallback: string }
      | undefined;
    expect(call?.mustConvey).toMatch(/Israel/);
    // The user-facing fallback (what the user actually sees if the LLM fails)
    // must never expose IANA timezone strings.
    expect(call?.fallback).toMatch(/Israel/);
    expect(call?.fallback).not.toMatch(/America\/New_York/);
    expect(call?.fallback).not.toMatch(/timezone/i);

    const sendText = (ctx.channel as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(mocks.updateBrand).not.toHaveBeenCalled();
  });

  it('initial run with unrecognized country: falls back to open ask', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('99999999999'));
    const ctx = makeCtx({ externalUserId: '99999999999' });

    await expect(timezoneStep.execute(ctx)).rejects.toBeInstanceOf(OnboardingStepSuspended);

    const call = mocks.phraseAsDuffy.mock.calls[0]?.[0] as
      | { mustConvey: string; fallback: string }
      | undefined;
    expect(call?.mustConvey).toMatch(/where they're based/i);
    // User-facing fallback should not leak IANA strings or the word "timezone".
    expect(call?.fallback).not.toMatch(/America\/New_York/);
    expect(call?.fallback).not.toMatch(/timezone/i);
  });

  it('affirmative reply with inferred tz: stores inferred and marks active', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('972501234567'));
    mocks.findBrandById.mockResolvedValue(
      fakeBrand({ status: 'active', timezone: 'Asia/Jerusalem' }),
    );

    const ctx = makeCtx({ resumeReply: 'yes' });
    const result = await timezoneStep.execute(ctx);

    expect(result).toEqual({ status: 'done' });
    expect(mocks.updateBrand).toHaveBeenCalledWith(BRAND_ID, {
      timezone: 'Asia/Jerusalem',
      status: 'active',
    });
  });

  it('city reply ("tlv") normalizes via keywords (the bug from the screenshot)', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('15558889999'));
    mocks.findBrandById.mockResolvedValue(
      fakeBrand({ status: 'active', timezone: 'Asia/Jerusalem' }),
    );

    const ctx = makeCtx({ resumeReply: "I'm from tlv", externalUserId: '15558889999' });
    const result = await timezoneStep.execute(ctx);

    expect(result).toEqual({ status: 'done' });
    expect(mocks.updateBrand).toHaveBeenCalledWith(BRAND_ID, {
      timezone: 'Asia/Jerusalem',
      status: 'active',
    });
  });

  it('reply with explicit IANA wins over inferred', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('972501234567'));
    mocks.findBrandById.mockResolvedValue(
      fakeBrand({ status: 'active', timezone: 'America/Los_Angeles' }),
    );

    const ctx = makeCtx({ resumeReply: 'America/Los_Angeles' });
    await timezoneStep.execute(ctx);

    expect(mocks.updateBrand).toHaveBeenCalledWith(BRAND_ID, {
      timezone: 'America/Los_Angeles',
      status: 'active',
    });
  });

  it('explicit "no" reply: re-prompts and does NOT mark active', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('972501234567'));

    const ctx = makeCtx({ resumeReply: 'no' });
    await expect(timezoneStep.execute(ctx)).rejects.toBeInstanceOf(OnboardingStepSuspended);

    expect(mocks.updateBrand).not.toHaveBeenCalled();
    const sendText = (ctx.channel as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('unparseable reply with inferred tz: silently uses inferred (better than UTC)', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('972501234567'));
    mocks.findBrandById.mockResolvedValue(
      fakeBrand({ status: 'active', timezone: 'Asia/Jerusalem' }),
    );

    const ctx = makeCtx({ resumeReply: 'somewhere over the rainbow' });
    await timezoneStep.execute(ctx);

    expect(mocks.updateBrand).toHaveBeenCalledWith(BRAND_ID, {
      timezone: 'Asia/Jerusalem',
      status: 'active',
    });
  });

  it('unparseable reply without inferred tz: re-prompts instead of writing UTC', async () => {
    mocks.findPrimaryChannelForBrand.mockResolvedValue(fakeChannel('99999999999'));

    const ctx = makeCtx({ resumeReply: 'somewhere', externalUserId: '99999999999' });
    await expect(timezoneStep.execute(ctx)).rejects.toBeInstanceOf(OnboardingStepSuspended);

    expect(mocks.updateBrand).not.toHaveBeenCalled();
  });
});
