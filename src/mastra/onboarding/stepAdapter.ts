import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { requireBrandChannel } from '../../channels/registry.js';
import { findBrandById } from '../../db/repositories/brands.js';
import {
  OnboardingStepSuspended,
  type OnboardingStep,
  type OnboardingStepContext,
  type SuspendReason,
} from './types.js';

/**
 * Adapter: wraps an `OnboardingStep` as a Mastra step that participates in
 * the brand-onboarding workflow. The workflow's `inputSchema` and
 * `outputSchema` are uniform — `{ brandId }` in, `{ brandId }` out — so
 * steps can be chained in any order via the plan list (`./plan.ts`).
 *
 * - `isComplete(brand)` short-circuits on re-entry: if the step's outputs
 *   are already persisted we pass through without prompting the user.
 * - `execute(ctx)` is re-entrant: on each resume Mastra re-invokes this
 *   wrapper with `resumeData`; the step decides where it is from brand
 *   state (igHandle null? brandKit null? etc.).
 * - `ctx.suspend(...)` returns `never` so the underlying `OnboardingStep`
 *   doesn't have to bother with control-flow returns; Mastra handles it.
 */

const onboardingStepInputSchema = z.object({ brandId: z.string() });
const onboardingStepOutputSchema = z.object({ brandId: z.string() });
const onboardingStepResumeSchema = z.object({ reply: z.string() });
// `passthrough` so steps can attach arbitrary debug fields (e.g. `mode`).
const onboardingStepSuspendSchema = z
  .object({ question: z.string() })
  .passthrough();

export function makeMastraStep(step: OnboardingStep) {
  return createStep({
    id: `onboarding:${step.id}`,
    inputSchema: onboardingStepInputSchema,
    outputSchema: onboardingStepOutputSchema,
    resumeSchema: onboardingStepResumeSchema,
    suspendSchema: onboardingStepSuspendSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      const brand = await findBrandById(inputData.brandId);
      if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);

      // Idempotency: if the step's work is already persisted AND we're not
      // resuming a suspend, pass through.
      if (!resumeData && step.isComplete(brand)) {
        return { brandId: inputData.brandId };
      }

      const channel = await requireBrandChannel(inputData.brandId);
      const ctx: OnboardingStepContext = {
        brandId: inputData.brandId,
        brand,
        channel,
        resumeData: resumeData ?? undefined,
        // `suspend` is implemented via a thrown sentinel so step execution
        // is guaranteed to abort at the suspend point. The catch below
        // translates that into a real Mastra suspend.
        suspend: (reason: SuspendReason): never => {
          throw new OnboardingStepSuspended(reason);
        },
      };

      try {
        const result = await step.execute(ctx);
        if (result.status === 'failed') {
          throw new Error(`Onboarding step "${step.id}" failed: ${result.error}`);
        }
        return { brandId: inputData.brandId };
      } catch (err) {
        if (err instanceof OnboardingStepSuspended) {
          await suspend(err.reason);
          return { brandId: inputData.brandId };
        }
        throw err;
      }
    },
  });
}
