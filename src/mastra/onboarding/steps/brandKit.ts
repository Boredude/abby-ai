import { logger } from '../../../config/logger.js';
import type { BoundChannel } from '../../../channels/types.js';
import { findBrandById, updateBrand } from '../../../db/repositories/brands.js';
import type { Brand } from '../../../db/schema.js';
import { normalizeIgHandle } from '../../../services/apify/instagramScraper.js';
import { analyzeBrand } from '../../../services/onboarding/analyzeBrand.js';
import {
  buildBrandBoardCaption,
  generateBrandBoard,
} from '../../../services/onboarding/brandBoardImage.js';
import { extractHandleWithLLM } from '../../../services/onboarding/extractHandle.js';
import {
  REVIEW_PROMPT,
  RETRY_HANDLE_PROMPT,
  buildBrandKitRecap,
  isExplicitApproval,
  looksLikeHandle,
} from '../../../services/onboarding/recap.js';
import { sayInDuffyVoice } from '../../../services/onboarding/voice.js';
import { getDuffyAgent } from '../../agents/duffy.js';
import { memoryFor } from '../../memory.js';
import type { OnboardingStep, OnboardingStepContext, OnboardingStepResult } from '../types.js';

/**
 * Brand-kit onboarding step: ask for the IG handle, run the analysis fan-out
 * (visuals + voice; future: screenshot grid, competitor scrape), present the
 * kit for review, and accept approval / edit / retry replies until the user
 * locks it in.
 *
 * This step replaces the previous v3 `ask-ig-handle` + `run-analysis-and-confirm`
 * Mastra steps. It keeps the same sub-flow but compacts it into a single
 * re-entrant `OnboardingStep`. Sub-state is recovered from the brand row on
 * each resume:
 *   - no `igHandle`        → user is answering "what's your IG handle?"
 *   - handle, no `brandKitJson` → analysis previously failed; user is replying
 *                                  with retry / a new handle / clarification
 *   - has `brandKitJson`   → user is reviewing (approve / new handle / edit)
 */

async function presentBrandKitToUser(
  brand: Brand,
  channel: BoundChannel,
  opts: { force?: boolean } = {},
): Promise<void> {
  try {
    const { url } = await generateBrandBoard(brand, opts);
    const caption = await sayInDuffyVoice({
      intent: 'brand_board_caption',
      brandId: brand.id,
      context: { igHandle: brand.igHandle },
      fallback: buildBrandBoardCaption(brand),
    });
    await channel.sendImage(url, caption);
  } catch (err) {
    logger.error(
      { err, brandId: brand.id },
      'Brand board image generation failed; falling back to text recap',
    );
    await channel.sendText(buildBrandKitRecap(brand));
  }
  await channel.sendText(
    await sayInDuffyVoice({
      intent: 'review_brand_kit_prompt',
      brandId: brand.id,
      context: { igHandle: brand.igHandle },
      fallback: REVIEW_PROMPT,
    }),
  );
}

async function presentBrandKitOrAskRetry(
  brandId: string,
  handle: string,
  channel: BoundChannel,
): Promise<'reviewing' | 'retry_handle' | 'service_unavailable'> {
  await channel.sendText(
    await sayInDuffyVoice({
      intent: 'analysis_starting',
      brandId,
      context: { igHandle: handle },
      fallback: `Diving into @${handle} now — give me a moment to study the feed.`,
    }),
  );

  const result = await analyzeBrand({ brandId, handle });
  if (!result.ok) {
    logger.warn(
      { brandId, handle, reason: result.reason },
      'Onboarding analysis failed',
    );
    if (result.reason === 'service_unavailable') {
      await channel.sendText(
        await sayInDuffyVoice({
          intent: 'analysis_failed_service_unavailable',
          brandId,
          context: { igHandle: handle },
          fallback: `Argh — hit a temporary hiccup on my side analyzing @${handle}. Reply 'retry' in a couple of minutes, or send a different handle.`,
        }),
      );
      return 'service_unavailable';
    }
    const intent =
      result.reason === 'private'
        ? 'analysis_failed_private'
        : result.reason === 'not_found'
          ? 'analysis_failed_not_found'
          : result.reason === 'empty'
            ? 'analysis_failed_empty'
            : 'analysis_failed_retry_handle';
    const fallback =
      result.reason === 'private'
        ? `@${handle} looks private — I can only analyze public accounts. Send a different handle (without the @).`
        : result.reason === 'not_found'
          ? `Couldn't find @${handle} on Instagram. Double-check the spelling and send it again (without the @)?`
          : result.reason === 'empty'
            ? `@${handle} doesn't have any posts I can analyze yet. Send a different handle?`
            : RETRY_HANDLE_PROMPT;
    await channel.sendText(
      await sayInDuffyVoice({
        intent,
        brandId,
        context: { igHandle: handle },
        fallback,
      }),
    );
    return 'retry_handle';
  }

  const refreshed = await findBrandById(brandId);
  if (!refreshed) throw new Error(`Brand ${brandId} not found`);
  await presentBrandKitToUser(refreshed, channel);
  return 'reviewing';
}

async function executeBrandKit(ctx: OnboardingStepContext): Promise<OnboardingStepResult> {
  const { brandId, channel, resumeData } = ctx;
  let brand = ctx.brand;

  // First-entry path (no user reply yet).
  if (!resumeData) {
    if (!brand.igHandle) {
      // Ask for the IG handle.
      await updateBrand(brandId, { status: 'onboarding' });
      await channel.sendText(
        await sayInDuffyVoice({
          intent: 'greet_and_ask_handle',
          brandId,
          fallback:
            "Hey, I'm Duffy — your AI content partner. I'll help you plan and draft Instagram posts. To start, what's your Instagram handle?",
        }),
      );
      ctx.suspend({ question: 'ig_handle' });
    }
    // We somehow re-entered with a handle but no kit (e.g. retry after a
    // service blip). Run the analysis now. Type-narrowing: brand.igHandle
    // is non-null here (the previous branch suspended).
    if (!brand.brandKitJson) {
      const handle = brand.igHandle as string;
      const mode = await presentBrandKitOrAskRetry(brandId, handle, channel);
      ctx.suspend({ question: 'brand_kit_review', mode });
    }
    await presentBrandKitToUser(brand, channel);
    ctx.suspend({ question: 'brand_kit_review', mode: 'reviewing' });
  }

  const reply = resumeData.reply.trim();

  // Sub-state 1: still awaiting an IG handle.
  if (!brand.igHandle) {
    const extracted = await extractHandleWithLLM(reply);
    if (extracted) {
      await updateBrand(brandId, { igHandle: extracted });
      const mode = await presentBrandKitOrAskRetry(brandId, extracted, channel);
      ctx.suspend({ question: 'brand_kit_review', mode });
    }
    const intent = looksLikeHandle(reply)
      ? 'ig_handle_invalid_format'
      : 'off_script_during_handle_ask';
    const fallback =
      intent === 'off_script_during_handle_ask'
        ? "Good question — but first I need your Instagram handle to get started. Send your username (like @nike) or the full instagram.com link?"
        : "That doesn't look like a valid Instagram handle. Send your username (like @nike, nike, or the full instagram.com link) and I'll try again.";
    await channel.sendText(
      await sayInDuffyVoice({
        intent,
        brandId,
        context: { userMessage: reply },
        fallback,
      }),
    );
    ctx.suspend({ question: 'ig_handle' });
  }

  // Sub-state 2: have handle but no brand kit — previous analysis failed,
  // user replied with retry / new handle / clarification.
  if (!brand.brandKitJson) {
    const lower = reply.toLowerCase();
    if (/^(retry|try again|again|same|same handle)\b/.test(lower) && brand.igHandle) {
      const mode = await presentBrandKitOrAskRetry(brandId, brand.igHandle, channel);
      ctx.suspend({ question: 'brand_kit_review', mode });
    }
    const newHandle = await extractHandleWithLLM(reply);
    if (!newHandle) {
      await channel.sendText(
        await sayInDuffyVoice({
          intent: 'analysis_failed_retry_handle',
          brandId,
          fallback: RETRY_HANDLE_PROMPT,
        }),
      );
      ctx.suspend({ question: 'brand_kit_review', mode: 'retry_handle' });
    }
    const validatedHandle = newHandle as string;
    await updateBrand(brandId, { igHandle: validatedHandle });
    const mode = await presentBrandKitOrAskRetry(brandId, validatedHandle, channel);
    ctx.suspend({ question: 'brand_kit_review', mode });
  }

  // Sub-state 3: brand kit exists — user is reviewing it.
  if (isExplicitApproval(reply)) {
    return { status: 'done' };
  }

  // Reply looks like another handle → re-run analysis on the new handle.
  if (looksLikeHandle(reply)) {
    let newHandle = '';
    try {
      newHandle = normalizeIgHandle(reply);
    } catch {
      newHandle = '';
    }
    if (newHandle) {
      await updateBrand(brandId, {
        igHandle: newHandle,
        brandKitJson: null,
        designSystemJson: null,
        voiceJson: null,
        igAnalysisJson: null,
      });
      const mode = await presentBrandKitOrAskRetry(brandId, newHandle, channel);
      ctx.suspend({ question: 'brand_kit_review', mode });
    }
  }

  // Free-form edit feedback → let Duffy apply it.
  try {
    const duffy = getDuffyAgent();
    const prompt = [
      `[brandId=${brandId}]`,
      `The user reviewed the brand kit and wants to tweak something.`,
      `Their feedback: "${reply}".`,
      `Apply the change with updateBrandContext if it maps to voice/cadence/timezone.`,
      `Keep your reply short — confirm what changed in one sentence.`,
    ].join(' ');
    const result = await duffy.generate(prompt, { memory: memoryFor(brandId) });
    const text = (result as { text?: string }).text?.trim() ?? '';
    if (text) await channel.sendText(text);
  } catch (err) {
    logger.error({ err, brandId }, 'Brand kit edit handling failed');
    await channel.sendText(
      await sayInDuffyVoice({
        intent: 'edit_apply_failed',
        brandId,
        fallback: 'Hit a snag applying that — mind rephrasing the change?',
      }),
    );
  }

  brand = (await findBrandById(brandId)) ?? brand;
  await presentBrandKitToUser(brand, channel, { force: true });
  ctx.suspend({ question: 'brand_kit_review', mode: 'reviewing' });
}

export const brandKitStep: OnboardingStep = {
  id: 'brand_kit',
  displayName: 'Brand kit',
  isComplete(brand) {
    // The kit is only "done" once the user has explicitly approved it. We
    // don't have a dedicated approved flag, but the review-loop in
    // executeBrandKit only returns `{ status: 'done' }` on explicit approval,
    // and the workflow's progression past this step is the actual record of
    // approval. So idempotency here is conservative: only consider this step
    // complete if the brand has moved beyond `onboarding` (e.g. the cadence
    // step set it to `active`) AND a kit exists.
    return brand.brandKitJson !== null && brand.status !== 'pending' && brand.status !== 'onboarding';
  },
  execute: executeBrandKit,
};
