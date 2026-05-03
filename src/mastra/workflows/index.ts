import { brandOnboardingWorkflow } from './brandOnboarding.js';
import { postDraftApprovalWorkflow } from './postDraftApproval.js';
import { startPostWorkflow } from './startPost.js';

export const workflows = {
  brandOnboarding: brandOnboardingWorkflow,
  postDraftApproval: postDraftApprovalWorkflow,
  startPost: startPostWorkflow,
} as const;

export type { DuffyWorkflowId } from './ids.js';
