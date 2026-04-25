import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { findBrandById, updateBrand } from '../../db/repositories/brands.js';
import { sendImage, sendText } from '../../services/kapso/client.js';
import { logger } from '../../config/logger.js';
import { getDuffyAgent } from '../agents/duffy.js';
import { analyzeBrand } from '../../services/onboarding/analyzeBrand.js';
import {
  InstagramScraperError,
  normalizeIgHandle,
} from '../../services/apify/instagramScraper.js';
import {
  REVIEW_PROMPT,
  RETRY_HANDLE_PROMPT,
  buildBrandKitRecap,
  isExplicitApproval,
  looksLikeHandle,
} from '../../services/onboarding/recap.js';
import {
  buildBrandBoardCaption,
  generateBrandBoard,
} from '../../services/onboarding/brandBoardImage.js';
import { sayInDuffyVoice } from '../../services/onboarding/voice.js';
import type { Brand, BrandCadence } from '../../db/schema.js';

/**
 * Brand onboarding workflow (v3 — analyze + review).
 *
 *   1. ask-ig-handle              → ask only for the IG handle.
 *   2. run-analysis-and-confirm   → call `analyzeBrand` directly (Apify scrape
 *      + visual + voice analysis + persist) and then send the user a
 *      structured recap built from the persisted brand kit, with an explicit
 *      review prompt. The user can:
 *        - approve ("yes", "lock it in", …) → move on
 *        - send a different handle → re-run analysis on the new handle
 *        - send free-form feedback → Duffy applies it via updateBrandProfile
 *      If the scrape failed, we ask the user to send another handle and
 *      retry instead of accepting any reply as approval. The analysis runs
 *      as plain code (not via an agent) so it always actually happens.
 *   3. ask-cadence-timezone-or-finalize → one combined question for cadence
 *      + timezone, then mark the brand active.
 *
 * Each step that asks the user suspends; the Kapso webhook resumes the run
 * with the user's reply via the inbound dispatcher.
 */

const replySchema = z.object({ reply: z.string() });
const suspendSchema = z.object({ question: z.string() });

async function getBrandPhone(brandId: string): Promise<string> {
  const brand = await findBrandById(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);
  return brand.waPhone;
}

/**
 * Send the brand kit to the user as a generated brand-board image with a
 * short caption. If image generation fails for any reason we fall back to
 * the structured text recap so the workflow never gets stuck.
 *
 * `force` is passed through to `generateBrandBoard` — set true on the
 * post-edit re-send path so we always regenerate after the kit changed.
 */
async function presentBrandKitToUser(
  brand: Brand,
  phone: string,
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
    await sendImage(phone, url, caption);
  } catch (err) {
    logger.error(
      { err, brandId: brand.id },
      'Brand board image generation failed; falling back to text recap',
    );
    await sendText(phone, buildBrandKitRecap(brand));
  }
  await sendText(
    phone,
    await sayInDuffyVoice({
      intent: 'review_brand_kit_prompt',
      brandId: brand.id,
      context: { igHandle: brand.igHandle },
      fallback: REVIEW_PROMPT,
    }),
  );
}

const askIgHandle = createStep({
  id: 'ask-ig-handle',
  inputSchema: z.object({ brandId: z.string() }),
  outputSchema: z.object({ brandId: z.string(), igHandle: z.string() }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await updateBrand(inputData.brandId, { status: 'onboarding' });
      await sendText(
        phone,
        await sayInDuffyVoice({
          intent: 'greet_and_ask_handle',
          brandId: inputData.brandId,
          fallback:
            "Hey, I'm Duffy — your AI content partner. I'll help you plan and draft Instagram posts. To start, what's your Instagram handle?",
        }),
      );
      await suspend({ question: 'ig_handle' });
      return undefined as never;
    }
    let igHandle: string;
    try {
      igHandle = normalizeIgHandle(resumeData.reply);
    } catch (err) {
      if (!(err instanceof InstagramScraperError)) throw err;
      const phone = await getBrandPhone(inputData.brandId);
      // If the user replied with something that doesn't even resemble a handle
      // (e.g. "what can you do?" or "wdym?"), treat it as an off-script
      // question and let Duffy actually react before re-asking. This avoids the
      // "two identical canned replies" UX bug where any non-handle reply hit
      // the same hardcoded "that doesn't look like a valid handle" message.
      const intent = looksLikeHandle(resumeData.reply)
        ? 'ig_handle_invalid_format'
        : 'off_script_during_handle_ask';
      const fallback =
        intent === 'off_script_during_handle_ask'
          ? "Good question — but first I need your Instagram handle to get started. Send your username (like @nike) or the full instagram.com link?"
          : "That doesn't look like a valid Instagram handle. Send your username (like @nike, nike, or the full instagram.com link) and I'll try again.";
      await sendText(
        phone,
        await sayInDuffyVoice({
          intent,
          brandId: inputData.brandId,
          context: { userMessage: resumeData.reply },
          fallback,
        }),
      );
      await suspend({ question: 'ig_handle' });
      return undefined as never;
    }
    await updateBrand(inputData.brandId, { igHandle });
    return { brandId: inputData.brandId, igHandle };
  },
});

async function presentBrandKitOrAskRetry(
  brandId: string,
  handle: string,
): Promise<'reviewing' | 'retry_handle' | 'service_unavailable'> {
  const phone = await getBrandPhone(brandId);
  await sendText(
    phone,
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
      await sendText(
        phone,
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
    await sendText(
      phone,
      await sayInDuffyVoice({
        intent,
        brandId,
        context: { igHandle: handle },
        fallback,
      }),
    );
    return 'retry_handle';
  }

  const brand = await findBrandById(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);
  await presentBrandKitToUser(brand, phone);
  return 'reviewing';
}

const reviewSuspendSchema = z.object({
  question: z.string(),
  mode: z.enum(['reviewing', 'retry_handle', 'service_unavailable']),
});

const runAnalysisAndConfirm = createStep({
  id: 'run-analysis-and-confirm',
  inputSchema: z.object({ brandId: z.string(), igHandle: z.string() }),
  outputSchema: z.object({ brandId: z.string(), confirmed: z.boolean() }),
  resumeSchema: replySchema,
  suspendSchema: reviewSuspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const mode = await presentBrandKitOrAskRetry(inputData.brandId, inputData.igHandle);
      await suspend({ question: 'brand_kit_review', mode });
      return undefined as never;
    }

    const reply = resumeData.reply.trim();
    const phone = await getBrandPhone(inputData.brandId);
    const brand = await findBrandById(inputData.brandId);
    if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);

    // Branch 1: analysis previously failed → reply is either "retry" (same
    // handle), a new handle, or a clarification we re-prompt on.
    if (!brand.brandKitJson) {
      const lower = reply.toLowerCase();
      if (/^(retry|try again|again|same|same handle)\b/.test(lower) && brand.igHandle) {
        const mode = await presentBrandKitOrAskRetry(inputData.brandId, brand.igHandle);
        await suspend({ question: 'brand_kit_review', mode });
        return undefined as never;
      }
      let newHandle: string;
      try {
        newHandle = normalizeIgHandle(reply);
      } catch (err) {
        if (!(err instanceof InstagramScraperError)) throw err;
        await sendText(
          phone,
          await sayInDuffyVoice({
            intent: 'analysis_failed_retry_handle',
            brandId: inputData.brandId,
            fallback: RETRY_HANDLE_PROMPT,
          }),
        );
        await suspend({ question: 'brand_kit_review', mode: 'retry_handle' });
        return undefined as never;
      }
      await updateBrand(inputData.brandId, { igHandle: newHandle });
      const mode = await presentBrandKitOrAskRetry(inputData.brandId, newHandle);
      await suspend({ question: 'brand_kit_review', mode });
      return undefined as never;
    }

    // Branch 2: explicit approval → move on.
    if (isExplicitApproval(reply)) {
      return { brandId: inputData.brandId, confirmed: true };
    }

    // Branch 3: looks like a single handle token / IG URL → re-run analysis on it.
    if (looksLikeHandle(reply)) {
      let newHandle: string;
      try {
        newHandle = normalizeIgHandle(reply);
      } catch {
        // looksLikeHandle said yes but normalize said no — fall through to edits.
        newHandle = '';
      }
      if (newHandle) {
        await updateBrand(inputData.brandId, {
          igHandle: newHandle,
          brandKitJson: null,
          designSystemJson: null,
          voiceJson: null,
          igAnalysisJson: null,
        });
        const mode = await presentBrandKitOrAskRetry(inputData.brandId, newHandle);
        await suspend({ question: 'brand_kit_review', mode });
        return undefined as never;
      }
    }

    // Branch 4: free-form edit feedback → let Duffy apply it.
    try {
      const duffy = getDuffyAgent();
      const prompt = [
        `[brandId=${inputData.brandId}]`,
        `The user reviewed the brand kit and wants to tweak something.`,
        `Their feedback: "${reply}".`,
        `Apply the change with updateBrandProfile if it maps to voice/cadence/timezone.`,
        `Keep your reply short — confirm what changed in one sentence.`,
      ].join(' ');
      const result = await duffy.generate(prompt, {
        memory: { thread: `brand:${inputData.brandId}`, resource: inputData.brandId },
      });
      const text = (result as { text?: string }).text?.trim() ?? '';
      if (text) await sendText(phone, text);
    } catch (err) {
      logger.error({ err, brandId: inputData.brandId }, 'Brand kit edit handling failed');
      await sendText(
        phone,
        await sayInDuffyVoice({
          intent: 'edit_apply_failed',
          brandId: inputData.brandId,
          fallback: 'Hit a snag applying that — mind rephrasing the change?',
        }),
      );
    }

    const refreshed = await findBrandById(inputData.brandId);
    if (refreshed) {
      await presentBrandKitToUser(refreshed, phone, { force: true });
    } else {
      await sendText(
        phone,
        await sayInDuffyVoice({
          intent: 'review_brand_kit_prompt',
          brandId: inputData.brandId,
          fallback: REVIEW_PROMPT,
        }),
      );
    }
    await suspend({ question: 'brand_kit_review', mode: 'reviewing' });
    return undefined as never;
  },
});

const askCadenceTimezoneOrFinalize = createStep({
  id: 'ask-cadence-timezone-or-finalize',
  inputSchema: z.object({ brandId: z.string(), confirmed: z.boolean() }),
  outputSchema: z.object({ brandId: z.string(), status: z.literal('active') }),
  resumeSchema: replySchema,
  suspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const phone = await getBrandPhone(inputData.brandId);
      await sendText(
        phone,
        await sayInDuffyVoice({
          intent: 'cadence_timezone_question',
          brandId: inputData.brandId,
          fallback:
            'Locked in. Two quick last things and we\'re set: how often do you want to post (e.g. "3 a week, mornings") and what\'s your timezone (e.g. America/New_York)?',
        }),
      );
      await suspend({ question: 'cadence_and_timezone' });
      return undefined as never;
    }

    const { cadence, timezone } = parseCadenceAndTimezone(resumeData.reply);
    await updateBrand(inputData.brandId, {
      cadenceJson: cadence,
      timezone,
      status: 'active',
    });

    const brand = await findBrandById(inputData.brandId);
    if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);

    const fallbackSummary = [
      `Perfect, you're all set! 🎉`,
      `• Instagram: @${brand.igHandle}`,
      `• Posts/week: ${cadence.postsPerWeek}`,
      `• Timezone: ${timezone}`,
      ``,
      `I'll start drafting posts and check in with you over the week. Reply any time if you want to brainstorm something.`,
    ].join('\n');
    await sendText(
      brand.waPhone,
      await sayInDuffyVoice({
        intent: 'onboarding_complete_summary',
        brandId: brand.id,
        context: {
          igHandle: brand.igHandle,
          postsPerWeek: cadence.postsPerWeek,
          timezone,
        },
        fallback: fallbackSummary,
      }),
    );
    logger.info({ brandId: brand.id }, 'Brand onboarding complete');

    return { brandId: inputData.brandId, status: 'active' as const };
  },
});

export const brandOnboardingWorkflow = createWorkflow({
  id: 'brandOnboarding',
  inputSchema: z.object({ brandId: z.string() }),
  outputSchema: z.object({ brandId: z.string(), status: z.literal('active') }),
})
  .then(askIgHandle)
  .then(runAnalysisAndConfirm)
  .then(askCadenceTimezoneOrFinalize)
  .commit();

// ---- helpers ----

function parseCadenceAndTimezone(input: string): { cadence: BrandCadence; timezone: string } {
  return {
    cadence: parseCadence(input),
    timezone: normalizeTimezone(input),
  };
}

function parseCadence(input: string): BrandCadence {
  const numMatch = input.match(/(\d+)/);
  const postsPerWeek = numMatch ? Math.min(21, Math.max(1, Number(numMatch[1]))) : 3;
  const cadence: BrandCadence = { postsPerWeek };
  const lower = input.toLowerCase();
  if (lower.includes('morning')) cadence.preferredHourLocal = 9;
  else if (lower.includes('lunch') || lower.includes('noon') || lower.includes('mid'))
    cadence.preferredHourLocal = 12;
  else if (lower.includes('afternoon')) cadence.preferredHourLocal = 15;
  else if (lower.includes('evening') || lower.includes('night')) cadence.preferredHourLocal = 19;
  return cadence;
}

function normalizeTimezone(input: string): string {
  const trimmed = input.trim();
  // Already an IANA-looking value: keep the first matching token.
  const ianaMatch = trimmed.match(/[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+/);
  if (ianaMatch) return ianaMatch[0];
  const lower = trimmed.toLowerCase();
  if (lower.includes('new york') || lower.includes('nyc') || /\best\b/.test(lower))
    return 'America/New_York';
  if (lower.includes('los angeles') || /\bla\b/.test(lower) || /\bpst\b/.test(lower))
    return 'America/Los_Angeles';
  if (lower.includes('madrid')) return 'Europe/Madrid';
  if (lower.includes('london') || /\bgmt\b/.test(lower) || /\butc\b/.test(lower)) return 'UTC';
  if (lower.includes('tel aviv') || lower.includes('israel')) return 'Asia/Jerusalem';
  if (lower.includes('tokyo')) return 'Asia/Tokyo';
  return 'UTC';
}
