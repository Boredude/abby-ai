import { logger } from '../../config/logger.js';
import { updateBrand } from '../../db/repositories/brands.js';
import {
  fetchInstagramProfile,
  InstagramScraperError,
} from '../apify/instagramScraper.js';
import { analyzeInstagramVisuals } from './analyzeVisuals.js';
import { analyzeInstagramVoice } from './analyzeVoice.js';
import { synthesizeBrandKit } from './synthesizeBrandKit.js';

export type AnalyzeBrandResult =
  | { ok: true; handle: string }
  | {
      ok: false;
      handle: string;
      reason: 'not_found' | 'private' | 'empty' | 'rate_limited' | 'unknown';
      message: string;
    };

/**
 * Run the full IG → brand kit analysis pipeline directly (no agent in the
 * loop) and persist the result to the brand row. Returns a structured
 * outcome the workflow can branch on.
 *
 * We invoke the services synchronously rather than going through Abby /
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

  const imageUrls = scrape.posts.slice(0, 9).map((p) => p.imageUrl);
  const captions = scrape.posts.map((p) => p.caption);

  let visuals;
  let voice;
  try {
    [visuals, voice] = await Promise.all([
      analyzeInstagramVisuals({
        handle: input.handle,
        imageUrls,
        ...(input.brandHint ? { brandHint: input.brandHint } : {}),
      }),
      analyzeInstagramVoice({
        handle: input.handle,
        ...(scrape.profile.biography ? { biography: scrape.profile.biography } : {}),
        captions,
        ...(input.brandHint ? { brandHint: input.brandHint } : {}),
      }),
    ]);
  } catch (err) {
    log.error({ err }, 'Brand analysis (visuals/voice) failed');
    return {
      ok: false,
      handle: input.handle,
      reason: 'unknown',
      message: (err as Error).message,
    };
  }

  const synthesized = synthesizeBrandKit({ scrape, visuals, voice });

  await updateBrand(input.brandId, {
    igHandle: scrape.profile.username,
    brandKitJson: synthesized.brandKit,
    designSystemJson: synthesized.designSystem,
    voiceJson: synthesized.voice,
    igAnalysisJson: synthesized.igAnalysis,
  });

  log.info('Brand analysis succeeded and persisted');
  return { ok: true, handle: scrape.profile.username };
}
