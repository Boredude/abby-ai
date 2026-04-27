import { createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { DEFAULT_ONBOARDING_PLAN } from '../onboarding/plan.js';
import { makeMastraStep } from '../onboarding/stepAdapter.js';
import type { OnboardingStep } from '../onboarding/types.js';

/**
 * Brand onboarding workflow (v4 — plan-driven).
 *
 * The workflow is built dynamically from a plan list (`DEFAULT_ONBOARDING_PLAN`).
 * Each entry in the plan is an `OnboardingStep`; the adapter (`makeMastraStep`)
 * wraps it into a uniform Mastra step (`{ brandId } → { brandId }`), and we
 * chain them with `.then()` in plan order.
 *
 * Adding a new step (e.g. "connect TikTok") is a one-line edit to
 * `DEFAULT_ONBOARDING_PLAN`. Removing or reordering is the same. The user-
 * facing flow, suspend/resume mechanics, and idempotency on re-entry are
 * unchanged from the v3 hard-coded version — we only changed the structure.
 */

type ChainableBuilder = {
  then: (step: ReturnType<typeof makeMastraStep>) => ChainableBuilder;
  commit: () => ReturnType<ReturnType<typeof createWorkflow>['commit']>;
};

function buildOnboardingWorkflow(plan: readonly OnboardingStep[]) {
  if (plan.length === 0) {
    throw new Error('Onboarding plan must contain at least one step');
  }

  // Every plan step has uniform input/output schemas (enforced by
  // `makeMastraStep`), so the workflow chain stays homogeneous. Mastra's
  // `.then()` deeply re-infers types after each chain link though, so
  // for a dynamic chain we use a structural cast — the homogeneity is
  // the actual invariant.
  const builder = createWorkflow({
    id: 'brandOnboarding',
    inputSchema: z.object({ brandId: z.string() }),
    outputSchema: z.object({ brandId: z.string() }),
  }) as unknown as ChainableBuilder;

  let chain: ChainableBuilder = builder;
  for (const step of plan) {
    chain = chain.then(makeMastraStep(step));
  }
  return chain.commit();
}

export const brandOnboardingWorkflow = buildOnboardingWorkflow(DEFAULT_ONBOARDING_PLAN);
