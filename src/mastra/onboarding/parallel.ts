import { logger } from '../../config/logger.js';

/**
 * In-step parallel fan-out helper.
 *
 * Onboarding steps frequently need to invoke multiple tools/agents
 * concurrently (scrape IG + analyze visuals + analyze voice + screenshot
 * grid + …). This utility runs them with `Promise.allSettled`, captures
 * per-task timing and errors as data, and never throws — letting callers
 * decide which failures are fatal and which are tolerable.
 */

export type ParallelTask<T> = {
  /** Stable name for logs/metrics (e.g. `'scrape'`, `'visuals'`, `'voice'`). */
  name: string;
  /** Optional bound on how long to wait for this task before timing out. */
  timeoutMs?: number;
  run: () => Promise<T>;
};

export type ParallelResult<T> =
  | { name: string; ok: true; value: T; durationMs: number }
  | { name: string; ok: false; error: Error; durationMs: number };

export type RunParallelOptions = {
  /** Optional log-prefix label, e.g. `'brandKit'`. */
  label?: string;
};

function withTimeout<T>(name: string, fn: () => Promise<T>, ms?: number): Promise<T> {
  if (!ms || ms <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Parallel task "${name}" timed out after ${ms}ms`));
    }, ms);
    fn().then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

export async function runParallel<T>(
  tasks: ParallelTask<T>[],
  opts: RunParallelOptions = {},
): Promise<ParallelResult<T>[]> {
  const label = opts.label ?? 'parallel';
  logger.info({ label, count: tasks.length, names: tasks.map((t) => t.name) }, 'runParallel: starting');

  const results = await Promise.all(
    tasks.map(async (task): Promise<ParallelResult<T>> => {
      const started = Date.now();
      try {
        const value = await withTimeout(task.name, task.run, task.timeoutMs);
        const durationMs = Date.now() - started;
        return { name: task.name, ok: true, value, durationMs };
      } catch (err) {
        const durationMs = Date.now() - started;
        const error = err instanceof Error ? err : new Error(String(err));
        return { name: task.name, ok: false, error, durationMs };
      }
    }),
  );

  for (const r of results) {
    if (r.ok) {
      logger.info({ label, task: r.name, ms: r.durationMs }, 'runParallel: task ok');
    } else {
      logger.warn(
        { label, task: r.name, ms: r.durationMs, err: r.error.message },
        'runParallel: task failed',
      );
    }
  }
  return results;
}

/** Convenience: assert all tasks succeeded; throw the first error otherwise. */
export function unwrapAll<T>(results: ParallelResult<T>[]): T[] {
  const failures = results.filter((r) => !r.ok) as Extract<ParallelResult<T>, { ok: false }>[];
  if (failures.length > 0) {
    const msg = failures.map((f) => `${f.name}: ${f.error.message}`).join('; ');
    throw new Error(`Parallel fan-out failed: ${msg}`);
  }
  return (results as Extract<ParallelResult<T>, { ok: true }>[]).map((r) => r.value);
}

/** Pick a single named task's result, or undefined if missing/failed. */
export function pickOk<T>(results: ParallelResult<T>[], name: string): T | undefined {
  const r = results.find((x) => x.name === name);
  return r && r.ok ? r.value : undefined;
}
