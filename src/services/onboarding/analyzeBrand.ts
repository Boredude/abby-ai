import { logger } from '../../config/logger.js';
import { updateBrand } from '../../db/repositories/brands.js';
import { pickOk, runParallel } from '../../mastra/onboarding/parallel.js';
import {
  fetchInstagramProfile,
  InstagramScraperError,
} from '../apify/instagramScraper.js';
import { analyzeInstagramProfilePic } from './analyzeProfilePic.js';
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

  const imageUrls = scrape.posts.map((p) => p.imageUrl);
  const captions = scrape.posts.map((p) => p.caption);
  const profilePicUrl = scrape.profile.profilePicUrlHD ?? scrape.profile.profilePicUrl;
  log.info(
    {
      postCount: scrape.posts.length,
      imageCount: imageUrls.length,
      hasProfilePic: Boolean(profilePicUrl),
    },
    'Sending full IG grid to analyzers',
  );

  // Profile pic is the source of palette + logo; without it we can't build a
  // brand kit, so fail fast with the same `empty` reason the scraper itself
  // would surface for an account with no usable content.
  if (!profilePicUrl) {
    log.warn('Instagram scrape returned no profile picture URL');
    return {
      ok: false,
      handle: input.handle,
      reason: 'empty',
      message: 'Instagram profile has no profile picture; cannot derive palette / logo.',
    };
  }

  // Fan-out: run the profile-pic + post-grid + voice analyzers in parallel
  // as named subtasks of the brand-kit step. Adding a future analyzer (e.g.
  // a Playwright grid screenshot or a competitor-scrape) is a one-line
  // addition here.
  type AnalyzerOutput =
    | Awaited<ReturnType<typeof analyzeInstagramProfilePic>>
    | Awaited<ReturnType<typeof analyzeInstagramVisuals>>
    | Awaited<ReturnType<typeof analyzeInstagramVoice>>;
  const fanout = await runParallel<AnalyzerOutput>(
    [
      {
        name: 'profilePic',
        run: () =>
          analyzeInstagramProfilePic({
            handle: input.handle,
            profilePicUrl,
            ...(input.brandHint ? { brandHint: input.brandHint } : {}),
          }),
      },
      {
        name: 'visuals',
        run: () =>
          analyzeInstagramVisuals({
            handle: input.handle,
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

  const profilePic = pickOk(fanout, 'profilePic') as
    | Awaited<ReturnType<typeof analyzeInstagramProfilePic>>
    | undefined;
  const visuals = pickOk(fanout, 'visuals') as
    | Awaited<ReturnType<typeof analyzeInstagramVisuals>>
    | undefined;
  const voice = pickOk(fanout, 'voice') as
    | Awaited<ReturnType<typeof analyzeInstagramVoice>>
    | undefined;
  if (!profilePic || !visuals || !voice) {
    log.error('Brand analysis fan-out missing profilePic, visuals, or voice');
    return {
      ok: false,
      handle: input.handle,
      reason: 'unknown',
      message: 'Brand analysis fan-out missing required outputs',
    };
  }

  const synthesized = synthesizeBrandKit({ scrape, profilePic, visuals, voice });

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
