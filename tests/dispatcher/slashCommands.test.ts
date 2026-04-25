import { describe, expect, it, vi } from 'vitest';
import { parseSlashCommand } from '../../src/services/slashCommands.js';
import type { ResetSummary } from '../../src/services/admin/resetBrandState.js';

const mocks = vi.hoisted(() => ({
  resetBrandByPhone: vi.fn(
    async (_pool: unknown, _phone: string): Promise<ResetSummary> => ({
      phone: '15558889999',
      brandId: 'brand-x',
      rowsDeleted: {
        mastraMessages: 1,
        mastraThreads: 1,
        mastraResources: 1,
        mastraWorkflowSnapshots: 1,
        brand: 1,
      },
    }),
  ),
  sendText: vi.fn(async (..._args: unknown[]) => ({})),
  upsertBrandByPhone: vi.fn(async (..._args: unknown[]) => ({
    id: 'brand-new',
    waPhone: '15558889999',
    igHandle: null,
    voiceJson: null,
    cadenceJson: null,
    timezone: 'UTC',
    status: 'pending' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  startWorkflow: vi.fn(async (..._args: unknown[]) => ({ runId: 'r', status: 'suspended' as const })),
  resumeWorkflow: vi.fn(async (..._args: unknown[]) => ({ status: 'success' as const })),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'noop' })),
  getPool: vi.fn(() => ({ /* fake pg.Pool */ })),
}));

vi.mock('../../src/services/admin/resetBrandState.js', () => ({
  resetBrandByPhone: mocks.resetBrandByPhone,
}));

vi.mock('../../src/services/kapso/client.js', () => ({
  sendText: mocks.sendText,
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: mocks.getPool,
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  upsertBrandByPhone: mocks.upsertBrandByPhone,
}));

vi.mock('../../src/db/repositories/workflowRuns.js', () => ({
  findActiveRunForBrand: vi.fn(async () => null),
  findRunByDraft: vi.fn(async () => null),
}));

vi.mock('../../src/services/workflowRunner.js', () => ({
  startWorkflow: mocks.startWorkflow,
  resumeWorkflow: mocks.resumeWorkflow,
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
    mocks.resetBrandByPhone.mockClear();
    mocks.sendText.mockClear();
    mocks.upsertBrandByPhone.mockClear();
    mocks.startWorkflow.mockClear();

    await dispatchInboundMessage({
      kind: 'text',
      text: '/reset',
      waMessageId: 'm-1',
      fromPhone: '15558889999',
    });

    expect(mocks.resetBrandByPhone).toHaveBeenCalledTimes(1);
    expect(mocks.resetBrandByPhone.mock.calls[0]?.[1]).toBe('15558889999');
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.upsertBrandByPhone).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it('replies with a friendly note when there is no brand to reset', async () => {
    mocks.resetBrandByPhone.mockClear();
    mocks.sendText.mockClear();
    mocks.resetBrandByPhone.mockResolvedValueOnce({
      phone: '15558889999',
      brandId: null,
      rowsDeleted: {
        mastraMessages: 0,
        mastraThreads: 0,
        mastraResources: 0,
        mastraWorkflowSnapshots: 0,
        brand: 0,
      },
    });

    await dispatchInboundMessage({
      kind: 'text',
      text: '/reset',
      waMessageId: 'm-2',
      fromPhone: '15558889999',
    });

    const reply = mocks.sendText.mock.calls[0]?.[1] as string;
    expect(reply.toLowerCase()).toContain('nothing to reset');
  });

  it('responds to /help with a command list', async () => {
    mocks.resetBrandByPhone.mockClear();
    mocks.sendText.mockClear();

    await dispatchInboundMessage({
      kind: 'text',
      text: '/help',
      waMessageId: 'm-3',
      fromPhone: '15558889999',
    });

    expect(mocks.resetBrandByPhone).not.toHaveBeenCalled();
    const reply = mocks.sendText.mock.calls[0]?.[1] as string;
    expect(reply).toContain('/reset');
    expect(reply).toContain('/help');
  });

  it('replies with help text for unknown commands', async () => {
    mocks.sendText.mockClear();

    await dispatchInboundMessage({
      kind: 'text',
      text: '/whatever',
      waMessageId: 'm-4',
      fromPhone: '15558889999',
    });

    const reply = mocks.sendText.mock.calls[0]?.[1] as string;
    expect(reply.toLowerCase()).toContain('unknown command');
    expect(reply).toContain('/whatever');
  });

  it('does NOT treat regular text as a slash command', async () => {
    mocks.resetBrandByPhone.mockClear();
    mocks.upsertBrandByPhone.mockClear();

    await dispatchInboundMessage({
      kind: 'text',
      text: 'hi duffy',
      waMessageId: 'm-5',
      fromPhone: '15558889999',
    });

    expect(mocks.resetBrandByPhone).not.toHaveBeenCalled();
    expect(mocks.upsertBrandByPhone).toHaveBeenCalledTimes(1);
  });
});
