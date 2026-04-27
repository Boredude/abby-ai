import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { updateBrand } from '../../db/repositories/brands.js';
import type { IgAnalysisSnapshot } from '../../db/schema.js';
import { pickOk, runParallel } from '../../mastra/onboarding/parallel.js';
import {
  fetchInstagramProfile,
  InstagramScraperError,
} from '../apify/instagramScraper.js';
import {
  captureInstagramGrid,
  IgGridCaptureError,
} from '../instagram/captureGrid.js';
import { analyzeInstagramVisuals } from './analyzeVisuals.js';
import { analyzeInstagramVoice } from './analyzeVoice.js';
import { synthesizeBrandKit } from './synthesizeBrandKit.js';

export type AnalyzeBrandResult =
  | { ok: true; handle: string }
  | {
      ok: false;
      handle: string;
      reason:
        | 'not_found'
        | 'private'
        | 'empty'
        | 'rate_limited'
        | 'service_unavailable' // our analyzer / 3rd-party API problem (billing, auth, 5xx)
        | 'unknown';
      message: string;
    };

/**
 * Try to recognize errors that are about *our* infra (Anthropic billing,
 * auth, 5xx) versus errors that are about the user's IG account. We don't
 * want to tell the user "your handle is wrong, try another" when their
 * handle was fine and we just ran out of credits.
 */
function classifyAnalyzerError(err: unknown): 'service_unavailable' | 'unknown' {
  const e = err as { name?: string; message?: string; statusCode?: number };
  const msg = (e?.message ?? '').toLowerCase();
  if (
    msg.includes('credit balance') ||
    msg.includes('insufficient_quota') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('unauthorized') ||
    msg.includes('authentication') ||
    msg.includes('api key') ||
    // Anthropic refuses to fetch URL-based images that the target's robots.txt
    // disallows. That's our infra problem (we should send bytes), not the
    // user's handle being wrong.
    msg.includes('robots.txt') ||
    msg.includes('disallowed')
  ) {
    return 'service_unavailable';
  }
  const status = e?.statusCode;
  if (typeof status === 'number' && (status === 401 || status === 403 || status === 429 || status >= 500)) {
    return 'service_unavailable';
  }
  return 'unknown';
}

/**
 * Run the full IG → brand kit analysis pipeline directly (no agent in the
 * loop) and persist the result to the brand row. Returns a structured
 * outcome the workflow can branch on.
 *
 * We invoke the services synchronously rather than going through Duffy /
 * OnboardingAgent because small chat models have proven unreliable at
 * actually calling the scrape tool — running it as code is deterministic.
 */
export async function analyzeBrand(input: {
  brandId: string;
  handle: string;
  brandHint?: string;
}): Promise<AnalyzeBrandResult> {
  const log = logger.child({ brandId: input.brandId, handle: input.handle });

  let scrape;
  try {
    scrape = await fetchInstagramProfile(input.handle);
  } catch (err) {
    if (err instanceof InstagramScraperError) {
      log.warn({ code: err.code, msg: err.message }, 'Instagram scrape failed');
      return { ok: false, handle: input.handle, reason: err.code, message: err.message };
    }
    log.error({ err }, 'Instagram scrape threw unexpectedly');
    return {
      ok: false,
      handle: input.handle,
      reason: 'unknown',
      message: (err as Error).message,
    };
  }

  const env = loadEnv();
  const imageUrls = scrape.posts.map((p) => p.imageUrl);
  const captions = scrape.posts.map((p) => p.caption);
  log.info(
    {
      postCount: scrape.posts.length,
      imageCount: imageUrls.length,
      gridEnabled: env.IG_GRID_CAPTURE_ENABLED,
    },
    'Sending full IG grid to analyzers',
  );

  // Layer 1 — Playwright grid capture (visuals input, if enabled).
  // Voice analysis is unaffected: we still feed it Apify captions + bio.
  // On any IgGridCaptureError we log and let the visual analyzer fall back
  // to today's behaviour (the Apify post images), so brand analysis never
  // fails just because Playwright did.
  let gridCapture: Awaited<ReturnType<typeof captureInstagramGrid>> | null = null;
  if (env.IG_GRID_CAPTURE_ENABLED) {
    try {
      gridCapture = await captureInstagramGrid({
        brandId: input.brandId,
        handle: scrape.profile.username,
      });
    } catch (err) {
      const code = err instanceof IgGridCaptureError ? err.code : 'unknown';
      log.warn(
        { err, phase: 'ig.grid.fallback', reason: code },
        'IG grid capture failed; falling back to Apify post images',
      );
    }
  }

  // Layer 2 — visual + voice analyzers (always parallel).
  type AnalyzerOutput =
    | Awaited<ReturnType<typeof analyzeInstagramVisuals>>
    | Awaited<ReturnType<typeof analyzeInstagramVoice>>;
  const fanout = await runParallel<AnalyzerOutput>(
    [
      {
        name: 'visuals',
        run: () =>
          gridCapture
            ? analyzeInstagramVisuals({
                handle: input.handle,
                source: 'grid',
                viewportShotUrls: gridCapture.viewportShotUrls,
                ...(gridCapture.profilePicUrl
                  ? { profilePicUrl: gridCapture.profilePicUrl }
                  : {}),
                ...(input.brandHint ? { brandHint: input.brandHint } : {}),
              })
            : analyzeInstagramVisuals({
                handle: input.handle,
                source: 'posts',
                imageUrls,
                ...(input.brandHint ? { brandHint: input.brandHint } : {}),
              }),
      },
      {
        name: 'voice',
        run: () =>
          analyzeInstagramVoice({
            handle: input.handle,
            ...(scrape.profile.biography ? { biography: scrape.profile.biography } : {}),
            captions,
            ...(input.brandHint ? { brandHint: input.brandHint } : {}),
          }),
      },
    ],
    { label: 'brandKit:analyze' },
  );

  const firstFailure = fanout.find((r) => !r.ok);
  if (firstFailure && !firstFailure.ok) {
    const reason = classifyAnalyzerError(firstFailure.error);
    log.error(
      { err: firstFailure.error, task: firstFailure.name, reason },
      'Brand analysis fan-out failed',
    );
    return {
      ok: false,
      handle: input.handle,
      reason,
      message: firstFailure.error.message,
    };
  }

  const visuals = pickOk(fanout, 'visuals') as
    | Awaited<ReturnType<typeof analyzeInstagramVisuals>>
    | undefined;
  const voice = pickOk(fanout, 'voice') as
    | Awaited<ReturnType<typeof analyzeInstagramVoice>>
    | undefined;
  if (!visuals || !voice) {
    log.error('Brand analysis fan-out missing visuals or voice');
    return {
      ok: false,
      handle: input.handle,
      reason: 'unknown',
      message: 'Brand analysis fan-out missing required outputs',
    };
  }

  const gridCaptureMeta: IgAnalysisSnapshot['gridCapture'] | undefined = gridCapture
    ? {
        ...(gridCapture.profilePicUrl ? { profilePicUrl: gridCapture.profilePicUrl } : {}),
        viewportShotUrls: gridCapture.viewportShotUrls,
        capturedAt: gridCapture.capturedAt,
        source: 'playwright',
      }
    : undefined;

  const synthesized = synthesizeBrandKit({
    scrape,
    visuals,
    voice,
    ...(gridCaptureMeta ? { gridCapture: gridCaptureMeta } : {}),
  });

  await updateBrand(input.brandId, {
    igHandle: scrape.profile.username,
    brandKitJson: synthesized.brandKit,
    designSystemJson: synthesized.designSystem,
    voiceJson: synthesized.voice,
    igAnalysisJson: synthesized.igAnalysis,
    // Invalidate any previously-generated brand board: the kit just changed,
    // so the next presentation step must regenerate from the new JSON.
    brandBoardImageUrl: null,
  });

  log.info('Brand analysis succeeded and persisted');
  return { ok: true, handle: scrape.profile.username };
}
