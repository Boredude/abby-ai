import { describe, expect, it, vi } from 'vitest';
import { makeMockBoundChannel, makeMockChannel } from '../helpers/mockChannel.js';

const PHONE = '15551112222';
const channelMocks = makeMockChannel(makeMockBoundChannel(PHONE));

const mocks = vi.hoisted(() => ({
  resumeWorkflow: vi.fn(async (_args: unknown) => ({ status: 'success' as const })),
  startWorkflow: vi.fn(async (_args: unknown) => ({ runId: 'new', status: 'suspended' as const })),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'agent reply' })),
}));

vi.mock('../../src/db/repositories/brandChannels.js', () => ({
  upsertBrandByChannel: vi.fn(async ({ kind, externalId }: { kind: string; externalId: string }) => ({
    brand: {
      id: 'brand-1',
      igHandle: 'acme',
      voiceJson: null,
      cadenceJson: null,
      brandKitJson: null,
      designSystemJson: null,
      igAnalysisJson: null,
      brandBoardImageUrl: null,
      timezone: 'UTC',
      status: 'active' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    channel: {
      id: 'bc-1',
      brandId: 'brand-1',
      kind,
      externalId,
      isPrimary: true,
      status: 'connected' as const,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    created: false,
  })),
}));

vi.mock('../../src/db/repositories/workflowRuns.js', () => ({
  findActiveRunForBrand: vi.fn(async () => ({
    id: 'run-row-1',
    runId: 'run-id-1',
    workflowId: 'postDraftApproval',
    brandId: 'brand-1',
    draftId: 'draft-1',
    suspendedStep: 'request-approval',
    suspendPayload: null,
    status: 'suspended',
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  findRunByDraft: vi.fn(async () => null),
}));

vi.mock('../../src/services/workflowRunner.js', () => ({
  resumeWorkflow: mocks.resumeWorkflow,
  startWorkflow: mocks.startWorkflow,
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

describe('dispatchInboundMessage → postDraftApproval resume payload', () => {
  it('approve button maps to { decision: "approve" }', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm1',
      kind: 'button',
      buttonId: 'approve_draft-1',
      buttonTitle: 'Approve',
      decision: 'approve',
      draftId: 'draft-1',
    });
    expect(mocks.resumeWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      workflowId: 'postDraftApproval',
      runId: 'run-id-1',
      resumeData: { decision: 'approve' },
    });
  });

  it('edit button maps to { decision: "edit" }', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm2',
      kind: 'button',
      buttonId: 'edit_draft-1',
      buttonTitle: 'Edit',
      decision: 'edit',
      draftId: 'draft-1',
    });
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      resumeData: { decision: 'edit' },
    });
  });

  it('reject button maps to { decision: "reject" }', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm3',
      kind: 'button',
      buttonId: 'reject_draft-1',
      buttonTitle: 'Reject',
      decision: 'reject',
      draftId: 'draft-1',
    });
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      resumeData: { decision: 'reject' },
    });
  });

  it('free text reply during suspended approval is treated as edit-with-note', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm4',
      kind: 'text',
      text: 'Make the caption more punchy please',
    });
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      resumeData: { decision: 'edit', editNote: 'Make the caption more punchy please' },
    });
  });
});
