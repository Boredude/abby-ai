import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand, BrandChannel } from '../../src/db/schema.js';
import { makeMockBoundChannel, makeMockChannel } from '../helpers/mockChannel.js';

/**
 * Integration test for the dispatcher's free-chat path: an already-onboarded
 * brand (`status='active'`) sends an inbound text → dispatcher loads the
 * BrandContext, hands a structured prompt to Duffy, and writes Duffy's
 * reply to the brand's channel via the channel adapter (MockChannel).
 *
 * This is the workflow-level guardrail the Phase 4 plan called out — it
 * exercises the (ChannelMessage + BrandContext + Channel) seam end-to-end
 * without touching real LLMs, Kapso, or Postgres.
 */

const channelMocks = makeMockChannel(makeMockBoundChannel('15558889999'));

const ACTIVE_BRAND: Brand = {
  id: 'brand-active',
  igHandle: 'nike',
  voiceJson: null,
  cadenceJson: { postsPerWeek: 3 },
  brandKitJson: { palette: [] },
  designSystemJson: null,
  igAnalysisJson: null,
  brandBoardImageUrl: null,
  timezone: 'America/New_York',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Brand;

const ACTIVE_CHANNEL: BrandChannel = {
  id: 'bc-1',
  brandId: 'brand-active',
  kind: 'whatsapp',
  externalId: '15558889999',
  isPrimary: true,
  status: 'connected',
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as BrandChannel;

const mocks = vi.hoisted(() => ({
  startWorkflow: vi.fn(async (_args: unknown) => ({ runId: 'r', status: 'suspended' as const })),
  resumeWorkflow: vi.fn(async (_args: unknown) => ({ status: 'success' as const })),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'Hey Nike — what can I run for you?' })),
  upsertBrandByChannel: vi.fn(),
  loadBrandContext: vi.fn(),
  findActiveRunForBrand: vi.fn(async () => null),
  findRunByDraft: vi.fn(async () => null),
}));

vi.mock('../../src/db/repositories/brandChannels.js', () => ({
  upsertBrandByChannel: mocks.upsertBrandByChannel,
}));

vi.mock('../../src/db/repositories/workflowRuns.js', () => ({
  findActiveRunForBrand: mocks.findActiveRunForBrand,
  findRunByDraft: mocks.findRunByDraft,
}));

vi.mock('../../src/services/workflowRunner.js', () => ({
  startWorkflow: mocks.startWorkflow,
  resumeWorkflow: mocks.resumeWorkflow,
}));

vi.mock('../../src/channels/registry.js', () => ({
  getChannel: vi.fn(() => channelMocks.channel),
  getBrandChannel: vi.fn(async () => channelMocks.bound),
  requireBrandChannel: vi.fn(async () => channelMocks.bound),
}));

vi.mock('../../src/context/BrandContext.js', () => ({
  loadBrandContext: mocks.loadBrandContext,
}));

vi.mock('../../src/mastra/agents/duffy.js', () => ({
  getDuffyAgent: () => ({ generate: mocks.agentGenerate }),
}));

import { dispatchInboundMessage } from '../../src/services/inboundDispatcher.js';

describe('dispatchInboundMessage → free chat (active brand)', () => {
  beforeEach(() => {
    mocks.startWorkflow.mockClear();
    mocks.resumeWorkflow.mockClear();
    mocks.agentGenerate.mockClear();
    mocks.upsertBrandByChannel.mockClear();
    mocks.loadBrandContext.mockClear();
    channelMocks.bound.sendText.mockClear();

    mocks.upsertBrandByChannel.mockResolvedValue({
      brand: ACTIVE_BRAND,
      channel: ACTIVE_CHANNEL,
      created: false,
    });
    mocks.loadBrandContext.mockResolvedValue({
      brand: ACTIVE_BRAND,
      channels: [ACTIVE_CHANNEL],
      primaryChannel: ACTIVE_CHANNEL,
      channelByKind: () => ACTIVE_CHANNEL,
    });
  });

  it('routes through Duffy with a BrandContext-derived prompt and replies via the channel', async () => {
    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: '15558889999',
      externalMessageId: 'm-1',
      kind: 'text',
      text: 'morning!',
    });

    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    expect(mocks.resumeWorkflow).not.toHaveBeenCalled();
    expect(mocks.loadBrandContext).toHaveBeenCalledWith('brand-active');
    expect(mocks.agentGenerate).toHaveBeenCalledTimes(1);

    // Prompt embeds a BrandContext summary (so Duffy doesn't re-fetch it).
    const prompt = mocks.agentGenerate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('brandId=brand-active');
    expect(prompt).toContain('status=active');
    expect(prompt).toContain('igHandle=nike');
    expect(prompt).toContain('timezone=America/New_York');
    expect(prompt).toContain('kit=present');
    expect(prompt).toContain('cadence=present');
    expect(prompt).toContain('channels=whatsapp');
    expect(prompt).toContain('morning!');

    // Memory thread targets the brand's resource (working memory uses this).
    const opts = mocks.agentGenerate.mock.calls[0]?.[1] as { memory?: unknown };
    expect(opts.memory).toEqual({ thread: 'brand:brand-active', resource: 'brand-active' });

    // Reply written through the channel adapter.
    expect(channelMocks.bound.sendText).toHaveBeenCalledTimes(1);
    expect(channelMocks.bound.sendText.mock.calls[0]?.[0]).toBe('Hey Nike — what can I run for you?');
  });

  it('falls back gracefully if the agent throws', async () => {
    mocks.agentGenerate.mockRejectedValueOnce(new Error('LLM kaboom'));

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: '15558889999',
      externalMessageId: 'm-2',
      kind: 'text',
      text: 'hello',
    });

    expect(channelMocks.bound.sendText).toHaveBeenCalledTimes(1);
    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/snag/i);
  });

  it('responds with a short error if BrandContext is missing post-upsert', async () => {
    mocks.loadBrandContext.mockResolvedValue(null);

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: '15558889999',
      externalMessageId: 'm-3',
      kind: 'text',
      text: 'what are you?',
    });

    expect(mocks.agentGenerate).not.toHaveBeenCalled();
    expect(channelMocks.bound.sendText).toHaveBeenCalledTimes(1);
  });
});
