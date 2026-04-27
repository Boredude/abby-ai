import { describe, expect, it, vi } from 'vitest';
import { makeMockBoundChannel, makeMockChannel } from '../helpers/mockChannel.js';

const channelMocks = makeMockChannel(makeMockBoundChannel('15558889999'));

const mocks = vi.hoisted(() => ({
  startWorkflow: vi.fn(async (_args: unknown) => ({ runId: 'run-x', status: 'suspended' as const })),
  resumeWorkflow: vi.fn(async (_args: unknown) => ({ status: 'success' as const })),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'unused' })),
}));

vi.mock('../../src/db/repositories/brandChannels.js', () => ({
  upsertBrandByChannel: vi.fn(async ({ kind, externalId }: { kind: string; externalId: string }) => ({
    brand: {
      id: 'brand-new',
      igHandle: null,
      voiceJson: null,
      cadenceJson: null,
      brandKitJson: null,
      designSystemJson: null,
      igAnalysisJson: null,
      brandBoardImageUrl: null,
      timezone: 'UTC',
      status: 'pending' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    channel: {
      id: 'bc-1',
      brandId: 'brand-new',
      kind,
      externalId,
      isPrimary: true,
      status: 'connected' as const,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    created: true,
  })),
}));

vi.mock('../../src/db/repositories/workflowRuns.js', () => ({
  findActiveRunForBrand: vi.fn(async () => null),
  findRunByDraft: vi.fn(async () => null),
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

vi.mock('../../src/mastra/agents/duffy.js', () => ({
  getDuffyAgent: () => ({ generate: mocks.agentGenerate }),
}));

import { dispatchInboundMessage } from '../../src/services/inboundDispatcher.js';

describe('dispatchInboundMessage → onboarding for new brand', () => {
  it('starts brandOnboarding when brand status is pending and no active run', async () => {
    mocks.startWorkflow.mockClear();
    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: '15558889999',
      externalMessageId: 'm-1',
      kind: 'text',
      text: 'hi',
    });
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      workflowId: 'brandOnboarding',
      brandId: 'brand-new',
      inputData: { brandId: 'brand-new' },
    });
  });
});
