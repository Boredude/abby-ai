import { logger } from '../../config/logger.js';
import { updateBrand } from '../../db/repositories/brands.js';
import { pickOk, runParallel } from '../../mastra/onboarding/parallel.js';
import {
  fetchInstagramProfile,
  InstagramScraperError,
  type InstagramScrapeResult,
} from '../apify/instagramScraper.js';
import { analyzeInstagramProfilePic } from './analyzeProfilePic.js';
import { analyzeInstagramVisuals } from './analyzeVisuals.js';
import { analyzeInstagramVoice } from './analyzeVoice.js';
import { analyzeWebsite, type WebsiteAnalysis } from './analyzeWebsite.js';
import { mirrorIgImages, type MirrorImageInput } from './igImageMirror.js';
import { reconcileTypography } from './reconcileTypography.js';
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
  /** User- or scraper-provided website URL. Falls back to scrape.profile.externalUrl. */
  website?: string;
  /** Reuse a previously-fetched scrape result (e.g. from a website-prompt sub-step). */
  prefetchedScrape?: InstagramScrapeResult;
}): Promise<AnalyzeBrandResult> {
  const log = logger.child({ brandId: input.brandId, handle: input.handle });

  let scrape: InstagramScrapeResult;
  if (input.prefetchedScrape) {
    scrape = input.prefetchedScrape;
  } else {
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

  // Resolve which website URL (if any) to feed into the optional website
  // analyzer: an explicit user-provided URL beats whatever the IG scraper
  // returned. We keep it best-effort: if the website analyzer fails we just
  // skip it; the kit still ships with IG-only typography.
  const effectiveWebsite = input.website ?? scrape.profile.externalUrl;

  // Kick off the IG-image-mirror in parallel with the analyzer fan-out:
  // download every IG asset we'll persist (profile pic + every post grid
  // image) and upload to R2 so the brand row stops carrying time-limited IG
  // CDN URLs. The analyzers themselves keep using the IG URLs (they download
  // bytes inline, so they don't benefit from the mirror); the synthesizer
  // and downstream brand-board step pick up whatever the mirror returns.
  const mirrorInputs: MirrorImageInput[] = [
    { label: 'profile-pic', url: profilePicUrl },
    ...scrape.posts.map((p, i) => ({ label: `post-${i + 1}`, url: p.imageUrl })),
  ].filter((i): i is MirrorImageInput => Boolean(i.url));
  const mirrorPromise = mirrorIgImages(
    { brandId: input.brandId, igHandle: input.handle },
    mirrorInputs,
  );

  // Fan-out: run the profile-pic + post-grid + voice analyzers in parallel
  // as named subtasks of the brand-kit step. The website analyzer joins the
  // fan-out only when we have a URL, and never causes the kit to fail.
  type AnalyzerOutput =
    | Awaited<ReturnType<typeof analyzeInstagramProfilePic>>
    | Awaited<ReturnType<typeof analyzeInstagramVisuals>>
    | Awaited<ReturnType<typeof analyzeInstagramVoice>>
    | Awaited<ReturnType<typeof analyzeWebsite>>;
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
      ...(effectiveWebsite
        ? [
            {
              name: 'website',
              run: () =>
                analyzeWebsite({
                  handle: input.handle,
                  websiteUrl: effectiveWebsite,
                  ...(input.brandHint ? { brandHint: input.brandHint } : {}),
                }),
            },
          ]
        : []),
    ],
    { label: 'brandKit:analyze' },
  );

  // Website failures are best-effort: ignore them when surfacing fatal errors.
  const firstFailure = fanout.find((r) => !r.ok && r.name !== 'website');
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

  // Only feed website data into the synthesizer when the analyzer actually
  // succeeded (it returns a failure object on parse/fetch errors instead of
  // throwing).
  const websiteResult = pickOk(fanout, 'website') as
    | Awaited<ReturnType<typeof analyzeWebsite>>
    | undefined;
  const website: WebsiteAnalysis | undefined =
    websiteResult && websiteResult.ok ? websiteResult : undefined;
  if (websiteResult && !websiteResult.ok) {
    log.warn(
      { reason: websiteResult.reason, msg: websiteResult.message, url: websiteResult.sourceUrl },
      'Website analysis failed; continuing without it',
    );
  }

  // Run two more independent steps in parallel:
  //  • Wait for the R2 mirror started above (failures silently drop entries
  //    and we keep the original IG URL for those — best-effort).
  //  • LLM-based typography reconciliation: combines the IG visual mood with
  //    the website analyzer's actual fonts into one coherent description.
  //    Falls back to the deterministic template in `synthesizeBrandKit`
  //    when the model call errors out (returns null).
  const [mirroredUrls, typography] = await Promise.all([
    mirrorPromise,
    reconcileTypography({
      handle: input.handle,
      visualTypographyMood: visuals.typographyMood,
      ...(website ? { website } : {}),
      ...(input.brandHint ? { brandHint: input.brandHint } : {}),
    }),
  ]);

  const synthesized = synthesizeBrandKit({
    scrape,
    profilePic,
    visuals,
    voice,
    ...(website ? { website } : {}),
    ...(typography ? { typography } : {}),
    mirroredUrls,
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
