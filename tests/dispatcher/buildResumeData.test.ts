import { describe, expect, it, vi } from 'vitest';

// vitest hoists vi.mock above imports, so any references to `vi.fn()` shared
// with assertions must be declared via `vi.hoisted` to also be hoisted.
const mocks = vi.hoisted(() => ({
  resumeWorkflow: vi.fn(async (_args: unknown) => ({ status: 'success' as const })),
  startWorkflow: vi.fn(async (_args: unknown) => ({ runId: 'new', status: 'suspended' as const })),
  sendText: vi.fn(async (..._args: unknown[]) => ({})),
  agentGenerate: vi.fn(async (..._args: unknown[]) => ({ text: 'agent reply' })),
}));

vi.mock('../../src/db/repositories/brands.js', () => ({
  upsertBrandByPhone: vi.fn(async ({ waPhone }: { waPhone: string }) => ({
    id: 'brand-1',
    waPhone,
    igHandle: 'acme',
    voiceJson: null,
    cadenceJson: null,
    timezone: 'UTC',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
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

vi.mock('../../src/services/kapso/client.js', () => ({
  sendText: mocks.sendText,
}));

vi.mock('../../src/mastra/agents/duffy.js', () => ({
  getDuffyAgent: () => ({ generate: mocks.agentGenerate }),
}));

import { dispatchInboundMessage } from '../../src/services/inboundDispatcher.js';

const PHONE = '15551112222';

describe('dispatchInboundMessage → postDraftApproval resume payload', () => {
  it('approve button maps to { decision: "approve" }', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      kind: 'button',
      buttonId: 'approve_draft-1',
      buttonTitle: 'Approve',
      decision: 'approve',
      draftId: 'draft-1',
      waMessageId: 'm1',
      fromPhone: PHONE,
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
      kind: 'button',
      buttonId: 'edit_draft-1',
      buttonTitle: 'Edit',
      decision: 'edit',
      draftId: 'draft-1',
      waMessageId: 'm2',
      fromPhone: PHONE,
    });
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      resumeData: { decision: 'edit' },
    });
  });

  it('reject button maps to { decision: "reject" }', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      kind: 'button',
      buttonId: 'reject_draft-1',
      buttonTitle: 'Reject',
      decision: 'reject',
      draftId: 'draft-1',
      waMessageId: 'm3',
      fromPhone: PHONE,
    });
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      resumeData: { decision: 'reject' },
    });
  });

  it('free text reply during suspended approval is treated as edit-with-note', async () => {
    mocks.resumeWorkflow.mockClear();
    await dispatchInboundMessage({
      kind: 'text',
      text: 'Make the caption more punchy please',
      waMessageId: 'm4',
      fromPhone: PHONE,
    });
    expect(mocks.resumeWorkflow.mock.calls[0]?.[0]).toMatchObject({
      resumeData: { decision: 'edit', editNote: 'Make the caption more punchy please' },
    });
  });
});
