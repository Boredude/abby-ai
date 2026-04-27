import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  DUFFY_IG_SESSION_ID,
  getIgSession,
  markIgSessionInvalid,
} from '../../db/repositories/igSessions.js';
import { uploadToR2 } from '../storage/r2.js';
import { normalizeIgHandle } from '../apify/instagramScraper.js';

/**
 * Headless Chromium IG-grid capture.
 *
 * Logs in as Duffy (via a previously seeded `ig_sessions` storageState),
 * navigates to https://www.instagram.com/<handle>/, and screenshots the grid
 * one viewport at a time until we've seen `IG_GRID_TARGET_POSTS` tiles or
 * hit the bottom of the grid. Each viewport PNG and the avatar are uploaded
 * to R2; their public URLs flow back to the visual analyzer.
 *
 * Failure modes are typed (`IgGridCaptureError`) so the orchestrator can
 * branch on `code` and decide whether to fall back to Apify post images,
 * mark the session invalid, or surface the error.
 */

export type IgGridCaptureCode =
  | 'no_session'
  | 'session_invalid'
  | 'private'
  | 'not_found'
  | 'timeout'
  | 'busy'
  | 'unknown';

export class IgGridCaptureError extends Error {
  constructor(
    public readonly code: IgGridCaptureCode,
    message: string,
  ) {
    super(message);
    this.name = 'IgGridCaptureError';
  }
}

export type IgGridCaptureInput = {
  brandId: string;
  handle: string;
};

export type IgGridCaptureResult = {
  profilePicUrl?: string;
  viewportShotUrls: string[];
  estimatedTilesSeen: number;
  capturedAt: string;
  /** The R2 key prefix shared by all artifacts of this capture. */
  artifactPrefix: string;
};

// Single-flight mutex so we never run two captures at once in this process.
// Chromium is ~300MB RSS; running concurrent captures on the API node would
// blow our memory budget on Railway. The orchestrator falls back to Apify
// post images when this is busy.
let activeCapture: Promise<unknown> | null = null;

export async function captureInstagramGrid(
  input: IgGridCaptureInput,
): Promise<IgGridCaptureResult> {
  if (activeCapture) {
    throw new IgGridCaptureError('busy', 'Another IG grid capture is already running');
  }
  const promise = runCapture(input).finally(() => {
    activeCapture = null;
  });
  activeCapture = promise;
  return promise;
}

async function runCapture(input: IgGridCaptureInput): Promise<IgGridCaptureResult> {
  const env = loadEnv();
  const handle = normalizeIgHandle(input.handle);
  const log = logger.child({ phase: 'ig.grid', brandId: input.brandId, handle });

  const session = await getIgSession(DUFFY_IG_SESSION_ID);
  if (!session) {
    log.warn('ig.grid.no_session: no ig_sessions row, run bootstrapIgSession');
    throw new IgGridCaptureError('no_session', 'No Duffy IG session in ig_sessions');
  }
  if (session.status !== 'active') {
    log.warn({ status: session.status }, 'ig.grid.no_session: session not active');
    throw new IgGridCaptureError(
      'no_session',
      `IG session status is "${session.status}"; re-run bootstrap`,
    );
  }

  const runId = randomUUID();
  const artifactPrefix = `brand-assets/${input.brandId}/ig-grid/${runId}`;
  const viewportShotUrls: string[] = [];
  let profilePicUrl: string | undefined;
  let estimatedTilesSeen = 0;

  log.info({ phase: 'ig.grid.start', runId }, 'Starting IG grid capture');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      storageState: session.storageStateJson as Parameters<
        typeof browser.newContext
      >[0] extends { storageState?: infer S }
        ? S
        : never,
      viewport: {
        width: env.IG_GRID_VIEWPORT_WIDTH,
        height: env.IG_GRID_VIEWPORT_HEIGHT,
      },
      // A real-looking UA helps us not get punted to a mobile/login wall.
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    const page = await context.newPage();

    const result = await withTimeout(
      env.IG_GRID_TIMEOUT_MS,
      capturePage({
        page,
        handle,
        artifactPrefix,
        targetTiles: env.IG_GRID_TARGET_POSTS,
        maxScrolls: env.IG_GRID_MAX_SCROLLS,
        viewportHeight: env.IG_GRID_VIEWPORT_HEIGHT,
        log,
      }),
    );
    profilePicUrl = result.profilePicUrl;
    viewportShotUrls.push(...result.viewportShotUrls);
    estimatedTilesSeen = result.estimatedTilesSeen;
  } catch (err) {
    if (err instanceof IgGridCaptureError) {
      if (err.code === 'session_invalid') {
        await markIgSessionInvalid(DUFFY_IG_SESSION_ID).catch((markErr) => {
          log.error({ err: markErr }, 'Failed to mark IG session invalid');
        });
      }
      throw err;
    }
    if ((err as Error).name === 'IgGridTimeoutError') {
      throw new IgGridCaptureError('timeout', 'IG grid capture timed out');
    }
    log.error({ err }, 'ig.grid.unknown error');
    throw new IgGridCaptureError('unknown', (err as Error).message);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  log.info(
    {
      phase: 'ig.grid.uploaded',
      shots: viewportShotUrls.length,
      tiles: estimatedTilesSeen,
    },
    'IG grid capture complete',
  );

  return {
    ...(profilePicUrl ? { profilePicUrl } : {}),
    viewportShotUrls,
    estimatedTilesSeen,
    capturedAt: new Date().toISOString(),
    artifactPrefix,
  };
}

type CapturePageArgs = {
  page: Page;
  handle: string;
  artifactPrefix: string;
  targetTiles: number;
  maxScrolls: number;
  viewportHeight: number;
  log: Logger;
};

async function capturePage(args: CapturePageArgs): Promise<{
  profilePicUrl?: string;
  viewportShotUrls: string[];
  estimatedTilesSeen: number;
}> {
  const { page, handle, artifactPrefix, targetTiles, maxScrolls, viewportHeight, log } = args;
  const profileUrl = `https://www.instagram.com/${handle}/`;

  // Per-step timeout — a slow network shouldn't eat the whole capture budget
  // on a single navigation.
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(20_000);

  const response = await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });

  // IG redirects unauth'd browsers to /accounts/login/. If we land there our
  // storageState is stale; fall through to the orchestrator with a clear code.
  const finalUrl = page.url();
  if (/\/accounts\/login\//.test(finalUrl) || /\/challenge\//.test(finalUrl)) {
    throw new IgGridCaptureError(
      'session_invalid',
      `IG redirected to ${new URL(finalUrl).pathname} — session needs re-bootstrap`,
    );
  }

  if (response && response.status() === 404) {
    throw new IgGridCaptureError('not_found', `@${handle} returned HTTP 404`);
  }

  // "Sorry, this page isn't available." = soft 200 with this exact copy.
  const notFoundText = await page
    .getByText(/Sorry, this page isn't available\.?/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (notFoundText) {
    throw new IgGridCaptureError('not_found', `@${handle} page not available`);
  }

  // Private accounts show "This Account is Private" + no grid. Even logged
  // in we typically can't see the grid unless we follow them.
  const privateBanner = await page
    .getByText(/This Account is Private/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (privateBanner) {
    throw new IgGridCaptureError('private', `@${handle} is private`);
  }

  // Wait for the first row of grid tiles to be in the DOM. Different IG
  // layouts use different containers, so we just look for any post link.
  await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 15_000 });

  // Profile pic — use the alt-text trick: IG marks the avatar with an alt
  // like "<handle>'s profile picture". Falling back to header img if that
  // fails. We fetch via the page context so IG cookies/CDN protection works.
  const profilePicSrc = await page
    .locator('header img, img[alt*="profile picture" i]')
    .first()
    .getAttribute('src')
    .catch(() => null);
  let profilePicUrl: string | undefined;
  if (profilePicSrc) {
    try {
      const fetched = await page.request.get(profilePicSrc, {
        headers: { referer: 'https://www.instagram.com/' },
      });
      if (fetched.ok()) {
        const body = Buffer.from(await fetched.body());
        const contentType = fetched.headers()['content-type'] ?? 'image/jpeg';
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const { url } = await uploadToR2({
          key: `${artifactPrefix}/profile.${ext}`,
          body,
          contentType,
        });
        profilePicUrl = url;
      }
    } catch (err) {
      log.warn({ err, profilePicSrc }, 'ig.grid: failed to fetch profile pic');
    }
  }

  const viewportShotUrls: string[] = [];
  let estimatedTilesSeen = 0;
  let lastScrollY = -1;

  for (let i = 0; i < maxScrolls; i++) {
    // Settle before screenshot — IG lazy-loads tiles and animates them in.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);

    const png = await page.screenshot({ fullPage: false, type: 'png' });
    const { url } = await uploadToR2({
      key: `${artifactPrefix}/viewport-${String(i).padStart(2, '0')}.png`,
      body: png,
      contentType: 'image/png',
    });
    viewportShotUrls.push(url);

    estimatedTilesSeen = await page
      .locator('a[href*="/p/"], a[href*="/reel/"]')
      .count()
      .catch(() => estimatedTilesSeen);

    // `page.evaluate` callbacks run inside the browser so window/document
    // exist there; we don't include lib.dom in tsconfig (it's a Node app),
    // so we pull them off `globalThis` with a local cast instead.
    const scrollState = await page.evaluate(() => {
      const w = (globalThis as unknown as {
        scrollY: number;
        innerHeight: number;
        document: { body: { scrollHeight: number } };
      });
      return {
        scrollY: Math.round(w.scrollY),
        atBottom:
          Math.ceil(w.scrollY + w.innerHeight) >=
          Math.floor(w.document.body.scrollHeight),
        pageHeight: Math.floor(w.document.body.scrollHeight),
      };
    });

    log.info(
      {
        phase: 'ig.grid.scroll',
        i,
        tilesSeen: estimatedTilesSeen,
        scrollY: scrollState.scrollY,
        pageHeight: scrollState.pageHeight,
      },
      'ig.grid.scroll',
    );

    if (estimatedTilesSeen >= targetTiles) break;
    if (scrollState.atBottom) break;
    // No-progress guard: if scrollY didn't change since last iteration, the
    // page isn't loading more. Prevents infinite loops on weird layouts.
    if (scrollState.scrollY === lastScrollY && i > 0) break;
    lastScrollY = scrollState.scrollY;

    await page.evaluate((h) => {
      (globalThis as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy(0, h);
    }, viewportHeight);
  }

  return {
    ...(profilePicUrl ? { profilePicUrl } : {}),
    viewportShotUrls,
    estimatedTilesSeen,
  };
}

class IgGridTimeoutError extends Error {
  override name = 'IgGridTimeoutError';
}

async function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IgGridTimeoutError(`Timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
