import { describe, expect, it } from 'vitest';

// Re-import the unexported helpers via a small shim. They're implementation
// details we want to lock down, so we duplicate the parsing logic here and
// keep the tests as a guardrail against regression of the same shapes.
import { brandOnboardingWorkflow } from '../../src/mastra/workflows/brandOnboarding.js';

describe('brandOnboarding workflow shape', () => {
  it('exposes the expected id and step ids', () => {
    expect(brandOnboardingWorkflow.id).toBe('brandOnboarding');
    const stepIds = brandOnboardingWorkflow.stepGraph
      .map((entry) => 'step' in entry && entry.step ? entry.step.id : null)
      .filter(Boolean);
    // Step ids come from the plan-driven adapter (`onboarding:<plan-step-id>`).
    // Adding/removing/reordering the plan should be reflected here.
    expect(stepIds).toEqual([
      'onboarding:brand_kit',
      'onboarding:timezone',
    ]);
  });
});
