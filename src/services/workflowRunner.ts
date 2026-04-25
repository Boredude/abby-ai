import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger.js';
import { markRunStatus, markSuspended, recordRun } from '../db/repositories/workflowRuns.js';
import { getMastra } from '../mastra/index.js';
import type { DuffyWorkflowId } from '../mastra/workflows/index.js';

type WorkflowResultLike = {
  status: 'success' | 'suspended' | 'failed' | string;
  suspended?: string[][] | string[];
  steps?: Record<string, unknown>;
  error?: unknown;
};

/**
 * Persist the run row + reflect the current Mastra result onto it.
 */
async function reflectResult(args: {
  runId: string;
  brandId: string;
  draftId?: string;
  workflowId: DuffyWorkflowId;
  result: WorkflowResultLike;
  isFirstStart: boolean;
}): Promise<void> {
  const { runId, brandId, draftId, workflowId, result, isFirstStart } = args;

  if (isFirstStart) {
    await recordRun({
      brandId,
      ...(draftId ? { draftId } : {}),
      runId,
      workflowId,
      status: result.status === 'suspended' ? 'suspended' : result.status === 'success' ? 'completed' : 'running',
    });
  }

  if (result.status === 'suspended') {
    const suspended = Array.isArray(result.suspended) ? result.suspended : [];
    const first = suspended[0];
    const stepId = Array.isArray(first) ? first[first.length - 1] : typeof first === 'string' ? first : undefined;
    await markSuspended(runId, {
      suspendedStep: stepId ?? 'unknown',
      suspendPayload: null,
    });
  } else if (result.status === 'success') {
    await markRunStatus(runId, 'completed');
  } else if (result.status === 'failed') {
    await markRunStatus(runId, 'failed');
    logger.error({ runId, workflowId, error: result.error }, 'Workflow run failed');
  }
}

export async function startWorkflow<TInput extends Record<string, unknown>>(args: {
  workflowId: DuffyWorkflowId;
  brandId: string;
  draftId?: string;
  inputData: TInput;
}): Promise<{ runId: string; status: string }> {
  const { workflowId, brandId, draftId, inputData } = args;
  const mastra = await getMastra();
  const wf = mastra.getWorkflow(workflowId);

  const runId = randomUUID();
  const run = await wf.createRun({ runId, resourceId: brandId });
  const result = (await run.start({ inputData } as Parameters<typeof run.start>[0])) as WorkflowResultLike;

  await reflectResult({
    runId,
    brandId,
    ...(draftId ? { draftId } : {}),
    workflowId,
    result,
    isFirstStart: true,
  });

  return { runId, status: result.status };
}

export async function resumeWorkflow(args: {
  workflowId: DuffyWorkflowId;
  runId: string;
  brandId: string;
  draftId?: string;
  resumeData: Record<string, unknown>;
}): Promise<{ status: string }> {
  const { workflowId, runId, brandId, draftId, resumeData } = args;
  const mastra = await getMastra();
  const wf = mastra.getWorkflow(workflowId);

  const run = await wf.createRun({ runId, resourceId: brandId });
  const result = (await run.resume({ resumeData })) as WorkflowResultLike;

  await reflectResult({
    runId,
    brandId,
    ...(draftId ? { draftId } : {}),
    workflowId,
    result,
    isFirstStart: false,
  });

  return { status: result.status };
}
