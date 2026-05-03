/**
 * The set of workflow ids recognised by the runner / dispatcher. Kept in
 * its own file (instead of on `workflows/index.ts`) so that code paths
 * which only need the id type can import it without pulling in the
 * workflow module graph — avoids circular imports when a workflow's steps
 * want to call `startWorkflow(...)` on themselves or siblings.
 */
export type DuffyWorkflowId = 'brandOnboarding' | 'postDraftApproval' | 'startPost';
