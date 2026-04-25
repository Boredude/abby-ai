import { brandOnboardingWorkflow } from './brandOnboarding.js';
import { postDraftApprovalWorkflow } from './postDraftApproval.js';

export const workflows = {
  brandOnboarding: brandOnboardingWorkflow,
  postDraftApproval: postDraftApprovalWorkflow,
} as const;

export type AbbyWorkflowId = keyof typeof workflows;
