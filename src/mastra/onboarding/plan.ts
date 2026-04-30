import type { OnboardingStep } from './types.js';
import { brandKitStep } from './steps/brandKit.js';
import { timezoneStep } from './steps/timezone.js';

/**
 * The default onboarding plan, in execution order.
 *
 * To add a new step (e.g. "connect TikTok", "verify email", "pick a posting
 * timezone for cross-promo"), implement an `OnboardingStep` and slot it in
 * here. The Mastra workflow is rebuilt from this list at module load.
 *
 * Removing or reordering is also just an array edit — every step is
 * independently re-entrant and reads its sub-state from the brand row, so
 * the plan order is the only thing the workflow cares about.
 */
export const DEFAULT_ONBOARDING_PLAN: readonly OnboardingStep[] = [
  brandKitStep,
  timezoneStep,
];

export function findStepById(
  plan: readonly OnboardingStep[],
  id: string,
): OnboardingStep | undefined {
  return plan.find((s) => s.id === id);
}
