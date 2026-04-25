import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startWorkflow: vi.fn(async (_args: unknown) => ({ runId: 'run-x', status: 'suspended' as const })),
  resumeWorkflow: vi.fn(async (_args: unknown) => ({ status: 'success' as const })),
  sendText: vi.fn(async (..._args: unknown[]) => ({})),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'unused' })),
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  upsertBrandByPhone: vi.fn(async ({ waPhone }: { waPhone: string }) => ({
    id: 'brand-new',
    waPhone,
    igHandle: null,
    voiceJson: null,
    cadenceJson: null,
    timezone: 'UTC',
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
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

vi.mock('../../src/services/kapso/client.js', () => ({
  sendText: mocks.sendText,
}));

vi.mock('../../src/mastra/agents/duffy.js', () => ({
  getDuffyAgent: () => ({ generate: mocks.agentGenerate }),
}));

import { dispatchInboundMessage } from '../../src/services/inboundDispatcher.js';

describe('dispatchInboundMessage → onboarding for new brand', () => {
  it('starts brandOnboarding when brand status is pending and no active run', async () => {
    mocks.startWorkflow.mockClear();
    await dispatchInboundMessage({
      kind: 'text',
      text: 'hi',
      waMessageId: 'm-1',
      fromPhone: '15558889999',
    });
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      workflowId: 'brandOnboarding',
      brandId: 'brand-new',
      inputData: { brandId: 'brand-new' },
    });
  });
});
