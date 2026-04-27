import 'dotenv/config';
import { chromium } from 'playwright';
import { loadEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getPool } from '../db/client.js';
import { upsertIgSession } from '../db/repositories/igSessions.js';

/**
 * One-time bootstrap CLI for Duffy's Instagram session.
 *
 *   pnpm tsx src/scripts/bootstrapIgSession.ts
 *
 * Opens a HEADED Chromium window pointed at the IG login page. The operator
 * types the username/password and resolves any 2FA / SMS / "remember device"
 * challenge by hand. As soon as we detect a logged-in feed (URL match), we
 * capture the browser context's `storageState` (cookies + localStorage) and
 * upsert it into the singleton `ig_sessions` row at id="duffy".
 *
 * The runtime grid-capture worker only ever consumes that storageState —
 * it never logs in unattended — so 2FA never shows up in production.
 *
 * IG_DUFFY_USERNAME / IG_DUFFY_PASSWORD env vars are convenience pre-fills;
 * if either is missing we just navigate to the login page and let the
 * operator type everything in.
 */

const LOGGED_IN_URL = /^https:\/\/www\.instagram\.com\/(\?.*)?$/;
const TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const env = loadEnv();
  const log = logger.child({ script: 'bootstrapIgSession' });

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      viewport: {
        width: env.IG_GRID_VIEWPORT_WIDTH,
        height: env.IG_GRID_VIEWPORT_HEIGHT,
      },
    });
    const page = await context.newPage();

    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
    });

    if (env.IG_DUFFY_USERNAME) {
      await page.fill('input[name="username"]', env.IG_DUFFY_USERNAME).catch(() => {});
    }
    if (env.IG_DUFFY_PASSWORD) {
      await page.fill('input[name="password"]', env.IG_DUFFY_PASSWORD).catch(() => {});
    }

    log.info(
      'Browser is open. Complete login (and any 2FA) manually. Waiting for the home feed…',
    );

    await page.waitForURL(LOGGED_IN_URL, { timeout: TIMEOUT_MS });

    const storageState = await context.storageState();
    await upsertIgSession({ storageState, status: 'active' });
    log.info('IG session bootstrapped and stored in ig_sessions (id="duffy", status="active")');
  } finally {
    await browser.close().catch(() => {});
    await getPool().end().catch(() => {});
  }
}

main().catch((err) => {
  logger.error({ err }, 'bootstrapIgSession failed');
  process.exit(1);
});
