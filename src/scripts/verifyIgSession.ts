import 'dotenv/config';
import { chromium } from 'playwright';
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getPool } from '../db/client.js';
import { getIgSession, markIgSessionInvalid } from '../db/repositories/igSessions.js';

/**
 * Operational health check for Duffy's IG session.
 *
 *   pnpm tsx src/scripts/verifyIgSession.ts <handle>
 *
 * Loads the persisted `storageState` from `ig_sessions`, navigates headlessly
 * to a public profile (default: `instagram`), and asserts we reach the grid
 * without being redirected to login/challenge. On failure the session row is
 * marked `invalid` so the next analysis run skips Playwright and falls back
 * to the Apify post-images visual path until the operator re-bootstraps.
 *
 * Exit codes:
 *   0 — session OK
 *   1 — session missing or invalid (after marking it so)
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const log = logger.child({ script: 'verifyIgSession' });
  const handle = process.argv[2] ?? 'instagram';

  const session = await getIgSession();
  if (!session) {
    log.error('No ig_sessions row — run `pnpm tsx src/scripts/bootstrapIgSession.ts` first');
    process.exit(1);
  }
  if (session.status !== 'active') {
    log.error({ status: session.status }, 'IG session is not active');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: session.storageStateJson as Parameters<
        typeof browser.newContext
      >[0] extends { storageState?: infer S }
        ? S
        : never,
      viewport: {
        width: env.IG_GRID_VIEWPORT_WIDTH,
        height: env.IG_GRID_VIEWPORT_HEIGHT,
      },
    });
    const page = await context.newPage();
    await page.goto(`https://www.instagram.com/${handle}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    const url = page.url();
    if (/\/accounts\/login\//.test(url) || /\/challenge\//.test(url)) {
      log.error({ redirectedTo: new URL(url).pathname }, 'Session is no longer valid');
      await markIgSessionInvalid();
      process.exit(1);
    }
    await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 15_000 });
    log.info({ handle }, 'IG session OK');
  } catch (err) {
    log.error({ err }, 'verifyIgSession failed');
    await markIgSessionInvalid().catch(() => {});
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
    await getPool().end().catch(() => {});
  }
}

main().catch((err) => {
  logger.error({ err }, 'verifyIgSession crashed');
  process.exit(1);
});
