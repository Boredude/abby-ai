import { describe, expect, it, vi } from 'vitest';
import { parseSlashCommand } from '../../src/services/slashCommands.js';
import type { ResetSummary } from '../../src/services/admin/resetBrandState.js';
import { makeMockBoundChannel, makeMockChannel } from '../helpers/mockChannel.js';

const PHONE = '15558889999';
const channelMocks = makeMockChannel(makeMockBoundChannel(PHONE));

const mocks = vi.hoisted(() => ({
  resetBrandByChannel: vi.fn(
    async (
      _pool: unknown,
      args: { kind: 'whatsapp'; externalId: string },
    ): Promise<ResetSummary> => ({
      channelKind: args.kind,
      externalId: args.externalId,
      brandId: 'brand-x',
      rowsDeleted: {
        mastraMessages: 1,
        mastraThreads: 1,
        mastraResources: 1,
        mastraWorkflowSnapshots: 1,
        mastraObservationalMemory: 1,
        pgBossJobs: 1,
        brand: 1,
      },
    }),
  ),
  upsertBrandByChannel: vi.fn(async ({ kind, externalId }: { kind: string; externalId: string }) => ({
    brand: {
      id: 'brand-new',
      igHandle: null as string | null,
      voiceJson: null,
      cadenceJson: null,
      brandKitJson: null,
      designSystemJson: null,
      igAnalysisJson: null,
      brandBoardImageUrl: null,
      timezone: 'UTC',
      status: 'pending' as 'pending' | 'onboarding' | 'active' | 'paused',
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
    created: true as boolean,
  })),
  startWorkflow: vi.fn(async (..._args: unknown[]) => ({ runId: 'r', status: 'suspended' as const })),
  resumeWorkflow: vi.fn(async (..._args: unknown[]) => ({ status: 'success' as const })),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'noop' })),
  getPool: vi.fn(() => ({ /* fake pg.Pool */ })),
}));

vi.mock('../../src/services/admin/resetBrandState.js', () => ({
  resetBrandByChannel: mocks.resetBrandByChannel,
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: mocks.getPool,
}));

vi.mock('../../src/db/repositories/brandChannels.js', () => ({
  upsertBrandByChannel: mocks.upsertBrandByChannel,
}));

const workflowRunsMocks = vi.hoisted(() => ({
  findActiveRunForBrand: vi.fn(async (..._args: unknown[]) => null as unknown),
}));
const findActiveRunForBrand = workflowRunsMocks.findActiveRunForBrand;

vi.mock('../../src/db/repositories/workflowRuns.js', () => ({
  findActiveRunForBrand: workflowRunsMocks.findActiveRunForBrand,
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

describe('parseSlashCommand', () => {
  it('parses /reset with no args', () => {
    expect(parseSlashCommand('/reset')).toEqual({ command: 'reset', args: [] });
  });

  it('lower-cases the command and trims surrounding whitespace', () => {
    expect(parseSlashCommand('   /Reset  ')).toEqual({ command: 'reset', args: [] });
  });

  it('captures additional args', () => {
    expect(parseSlashCommand('/help me out')).toEqual({ command: 'help', args: ['me', 'out'] });
  });

  it('returns null for non-slash text', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('  hi /reset')).toBeNull();
  });
});

describe('dispatchInboundMessage → slash commands', () => {
  it('routes /reset before any brand/workflow plumbing', async () => {
    mocks.resetBrandByChannel.mockClear();
    channelMocks.bound.sendText.mockClear();
    mocks.upsertBrandByChannel.mockClear();
    mocks.startWorkflow.mockClear();

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-1',
      kind: 'text',
      text: '/reset',
    });

    expect(mocks.resetBrandByChannel).toHaveBeenCalledTimes(1);
    expect(mocks.resetBrandByChannel.mock.calls[0]?.[1]).toEqual({
      kind: 'whatsapp',
      externalId: PHONE,
    });
    expect(channelMocks.bound.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.upsertBrandByChannel).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it('replies with a friendly note when there is no brand to reset', async () => {
    mocks.resetBrandByChannel.mockClear();
    channelMocks.bound.sendText.mockClear();
    mocks.resetBrandByChannel.mockResolvedValueOnce({
      channelKind: 'whatsapp',
      externalId: PHONE,
      brandId: null,
      rowsDeleted: {
        mastraMessages: 0,
        mastraThreads: 0,
        mastraResources: 0,
        mastraWorkflowSnapshots: 0,
        mastraObservationalMemory: 0,
        pgBossJobs: 0,
        brand: 0,
      },
    });

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-2',
      kind: 'text',
      text: '/reset',
    });

    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply.toLowerCase()).toContain('nothing to reset');
  });

  it('responds to /help with a command list', async () => {
    mocks.resetBrandByChannel.mockClear();
    channelMocks.bound.sendText.mockClear();

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-3',
      kind: 'text',
      text: '/help',
    });

    expect(mocks.resetBrandByChannel).not.toHaveBeenCalled();
    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply).toContain('/reset');
    expect(reply).toContain('/help');
  });

  it('replies with help text for unknown commands', async () => {
    channelMocks.bound.sendText.mockClear();

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-4',
      kind: 'text',
      text: '/whatever',
    });

    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply.toLowerCase()).toContain('unknown command');
    expect(reply).toContain('/whatever');
  });

  it('does NOT treat regular text as a slash command', async () => {
    mocks.resetBrandByChannel.mockClear();
    mocks.upsertBrandByChannel.mockClear();

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-5',
      kind: 'text',
      text: 'hi duffy',
    });

    expect(mocks.resetBrandByChannel).not.toHaveBeenCalled();
    expect(mocks.upsertBrandByChannel).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchInboundMessage → /post', () => {
  function setBrandStatus(status: 'pending' | 'onboarding' | 'active' | 'paused') {
    mocks.upsertBrandByChannel.mockImplementationOnce(
      async ({ kind, externalId }: { kind: string; externalId: string }) => ({
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
          status,
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
      }),
    );
  }

  it('kicks off the startPost workflow for an active brand with no args', async () => {
    channelMocks.bound.sendText.mockClear();
    mocks.startWorkflow.mockClear();
    findActiveRunForBrand.mockResolvedValueOnce(null);
    setBrandStatus('active');

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-post-1',
      kind: 'text',
      text: '/post',
    });

    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    const args = mocks.startWorkflow.mock.calls[0]?.[0] as {
      workflowId: string;
      inputData: Record<string, unknown>;
    };
    expect(args.workflowId).toBe('startPost');
    expect(args.inputData.briefingHint).toBeUndefined();
    // The channel ask is sent by the workflow's collect-brief step, not the
    // slash handler — so no text was sent by the command itself.
    expect(channelMocks.bound.sendText).not.toHaveBeenCalled();
  });

  it('passes the /post args as the briefingHint (preserving case)', async () => {
    mocks.startWorkflow.mockClear();
    findActiveRunForBrand.mockResolvedValueOnce(null);
    setBrandStatus('active');

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-post-2',
      kind: 'text',
      text: '/post Something About the Summer Menu',
    });

    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    const args = mocks.startWorkflow.mock.calls[0]?.[0] as {
      inputData: { briefingHint?: string };
    };
    expect(args.inputData.briefingHint).toBe('Something About the Summer Menu');
  });

  it('refuses to start /post while another workflow is suspended', async () => {
    channelMocks.bound.sendText.mockClear();
    mocks.startWorkflow.mockClear();
    findActiveRunForBrand.mockResolvedValueOnce({
      id: 'run-row',
      brandId: 'brand-1',
      draftId: null,
      runId: 'r-1',
      workflowId: 'postDraftApproval',
      suspendedStep: 'request-approval',
      suspendPayload: null,
      status: 'suspended',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setBrandStatus('active');

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-post-3',
      kind: 'text',
      text: '/post',
    });

    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply.toLowerCase()).toContain('already got a draft');
  });

  it('asks the user to finish onboarding first when status is pending', async () => {
    channelMocks.bound.sendText.mockClear();
    mocks.startWorkflow.mockClear();
    setBrandStatus('pending');

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-post-4',
      kind: 'text',
      text: '/post',
    });

    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply.toLowerCase()).toContain('finish setting up');
  });

  it('tells the user to unpause a paused brand before using /post', async () => {
    channelMocks.bound.sendText.mockClear();
    mocks.startWorkflow.mockClear();
    setBrandStatus('paused');

    await dispatchInboundMessage({
      channelKind: 'whatsapp',
      externalUserId: PHONE,
      externalMessageId: 'm-post-5',
      kind: 'text',
      text: '/post',
    });

    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    const reply = channelMocks.bound.sendText.mock.calls[0]?.[0] as string;
    expect(reply.toLowerCase()).toContain('paused');
  });
});
