import { describe, expect, it } from 'vitest';
import { pickOk, runParallel, unwrapAll } from '../../src/mastra/onboarding/parallel.js';

describe('runParallel', () => {
  it('returns one structured result per task in input order', async () => {
    const results = await runParallel<number>([
      { name: 'a', run: async () => 1 },
      { name: 'b', run: async () => 2 },
      { name: 'c', run: async () => 3 },
    ]);
    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('runs tasks concurrently (total time approximates the slowest)', async () => {
    const start = Date.now();
    await runParallel<number>([
      { name: 'fast', run: () => new Promise((r) => setTimeout(() => r(1), 30)) },
      { name: 'slow', run: () => new Promise((r) => setTimeout(() => r(2), 80)) },
    ]);
    // If they ran sequentially the total would be ~110ms. Allow generous slack
    // for slow CI but assert we're well under that.
    expect(Date.now() - start).toBeLessThan(150);
  });

  it('captures failures as structured Error results without throwing', async () => {
    const results = await runParallel<number>([
      { name: 'ok', run: async () => 42 },
      {
        name: 'boom',
        run: async () => {
          throw new Error('kaboom');
        },
      },
    ]);
    const ok = results.find((r) => r.name === 'ok');
    const boom = results.find((r) => r.name === 'boom');
    expect(ok?.ok).toBe(true);
    expect(boom?.ok).toBe(false);
    if (boom && !boom.ok) {
      expect(boom.error.message).toBe('kaboom');
    }
  });

  it('honors per-task timeoutMs', async () => {
    const results = await runParallel<number>([
      {
        name: 'too-slow',
        timeoutMs: 20,
        run: () => new Promise((r) => setTimeout(() => r(1), 200)),
      },
    ]);
    const r = results[0];
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.message).toMatch(/timed out/);
  });

  it('unwrapAll throws on any failure with all task names included', async () => {
    const results = await runParallel<number>([
      {
        name: 'a',
        run: async () => {
          throw new Error('A bad');
        },
      },
      {
        name: 'b',
        run: async () => {
          throw new Error('B bad');
        },
      },
    ]);
    expect(() => unwrapAll(results)).toThrow(/a: A bad.*b: B bad/);
  });

  it('pickOk returns the value of an ok task or undefined for missing/failed', async () => {
    const results = await runParallel<string>([
      { name: 'a', run: async () => 'A' },
      {
        name: 'b',
        run: async () => {
          throw new Error('nope');
        },
      },
    ]);
    expect(pickOk(results, 'a')).toBe('A');
    expect(pickOk(results, 'b')).toBeUndefined();
    expect(pickOk(results, 'missing')).toBeUndefined();
  });
});
