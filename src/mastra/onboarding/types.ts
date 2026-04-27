import type { BoundChannel } from '../../channels/types.js';
import type { Brand } from '../../db/schema.js';

/**
 * Pluggable onboarding-step framework.
 *
 * The product wants onboarding to be composed of swappable steps:
 *   - build a brand kit
 *   - connect Instagram for content posting
 *   - connect TikTok
 *   - set cadence + timezone
 *   - …
 *
 * Each step is a self-contained `OnboardingStep` that:
 *   - decides whether it's already complete (idempotency) for the brand,
 *   - drives any user prompts it needs by calling `ctx.suspend(...)`,
 *   - persists its own outputs to the brand (or wherever it lives),
 *   - returns `{ status: 'done' }` when the brand is ready to move on.
 *
 * A `runParallel` utility (see `./parallel.ts`) lets a step fan out to
 * multiple tools/agents concurrently and consolidate the results.
 */

/** Reason metadata passed through Mastra's `suspend()` for debugging / introspection. */
export type SuspendReason = {
  /** Stable id of what the user is being asked (e.g. `'ig_handle'`, `'cadence_and_timezone'`). */
  question: string;
  [key: string]: unknown;
};

/**
 * Internal control-flow exception used by `ctx.suspend(...)`. Throwing
 * (instead of returning) lets us guarantee that the step's `execute`
 * doesn't accidentally fall through past a suspend point — and lets TS
 * narrow correctly because `ctx.suspend` is typed `Promise<never>`.
 *
 * The Mastra adapter (`stepAdapter.ts`) catches this and turns it into a
 * real `suspend()` call on the underlying Mastra step.
 */
export class OnboardingStepSuspended extends Error {
  readonly reason: SuspendReason;
  constructor(reason: SuspendReason) {
    super(`onboarding step suspended: ${reason.question}`);
    this.name = 'OnboardingStepSuspended';
    this.reason = reason;
  }
}

/** Resume payload — what the dispatcher injects when the user replies. */
export type StepResumeData = {
  reply: string;
};

export type OnboardingStepContext = {
  brandId: string;
  brand: Brand;
  channel: BoundChannel;
  /** Present only when Mastra resumed this step with a user reply. */
  resumeData: StepResumeData | undefined;
  /**
   * Suspend the underlying Mastra step and surface a human-readable
   * `question` id for observability. Throws synchronously (returns
   * `never`) so the step's `execute` cannot accidentally fall through
   * past a suspend point — the adapter catches the sentinel and converts
   * it into a real Mastra `suspend()` call. The step resumes from its
   * entry point on the next user reply, with `resumeData` populated.
   */
  suspend: (reason: SuspendReason) => never;
};

export type OnboardingStepResult =
  | { status: 'done' }
  | { status: 'failed'; error: string };

/**
 * The contract every onboarding step implements.
 *
 * - `id` is stable (it's used in step ids exposed to Mastra, logs, and
 *   future user-visible "you're on step N of M" UIs).
 * - `displayName` is for human-facing copy/logs.
 * - `isComplete(brand)` lets the orchestrator skip steps whose work is
 *   already persisted (idempotency on retries / re-runs).
 * - `execute(ctx)` actually drives the step. It can suspend any number of
 *   times; on each resume Mastra re-invokes `execute` with the latest
 *   `resumeData`, so the step must be re-entrant and use brand state to
 *   decide where in its own sub-flow it is (the same pattern the v3
 *   workflow already uses).
 */
export interface OnboardingStep {
  readonly id: string;
  readonly displayName: string;
  isComplete(brand: Brand): boolean;
  execute(ctx: OnboardingStepContext): Promise<OnboardingStepResult>;
}
