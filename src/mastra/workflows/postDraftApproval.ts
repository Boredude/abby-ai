import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { requireBrandChannel } from '../../channels/registry.js';
import { logger } from '../../config/logger.js';
import { findBrandById } from '../../db/repositories/brands.js';
import {
  appendEditNote,
  createPostDraft,
  findDraftById,
  updateDraftStatus,
} from '../../db/repositories/postDrafts.js';
import { QUEUES, getBoss } from '../../jobs/queue.js';
import { generateDraftForBrand } from '../../services/draftGenerator.js';

/**
 * Post-draft approval workflow.
 *
 * 1. generate     → builds caption + image and creates a `post_drafts` row
 * 2. requestApproval → sends WA preview with [Approve | Edit | Reject] buttons,
 *                       SUSPENDS waiting for the brand to tap a button (or text reply)
 * 3. handleDecision → branches:
 *      - approve → mark approved, schedule pg-boss `deliverApprovedPost` at scheduled_at
 *      - edit    → record note, regenerate (loops back via dountil)
 *      - reject  → mark rejected
 *
 * The edit loop uses Mastra's `dountil` so an unhappy brand can iterate as
 * many times as they want before approving.
 */

const decisionSchema = z.enum(['approve', 'edit', 'reject']);

const generate = createStep({
  id: 'generate',
  inputSchema: z.object({
    brandId: z.string(),
    scheduledAt: z.string().describe('ISO date for delivery via WA when approved'),
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { brandId, scheduledAt, briefingHint, existingDraftId } = inputData;
    const result = await generateDraftForBrand({
      brandId,
      ...(briefingHint ? { briefingHint } : {}),
    });

    let draftId = existingDraftId;
    if (existingDraftId) {
      const updated = await updateDraftStatus(existingDraftId, 'draft', {
        caption: result.caption,
        mediaUrls: [result.imageUrl],
      });
      draftId = updated.id;
    } else {
      const draft = await createPostDraft({
        brandId,
        caption: result.caption,
        mediaUrls: [result.imageUrl],
        scheduledAt: new Date(scheduledAt),
        status: 'draft',
      });
      draftId = draft.id;
    }

    return { brandId, draftId: draftId!, scheduledAt };
  },
});

const requestApproval = createStep({
  id: 'request-approval',
  inputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    decision: decisionSchema,
    editNote: z.string().optional(),
  }),
  resumeSchema: z.object({
    decision: decisionSchema,
    editNote: z.string().optional(),
  }),
  suspendSchema: z.object({ draftId: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const brand = await findBrandById(inputData.brandId);
      if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);
      const draft = await findDraftById(inputData.draftId);
      if (!draft) throw new Error(`Draft ${inputData.draftId} not found`);
      const imageUrl = draft.mediaUrls[0];
      if (!imageUrl) throw new Error(`Draft ${draft.id} has no media URL`);

      const when = new Date(inputData.scheduledAt).toLocaleString('en-US', {
        timeZone: brand.timezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

      const body =
        `Here's a fresh post idea for @${brand.igHandle ?? 'your brand'} 👇\n\n` +
        `${draft.caption.length > 700 ? draft.caption.slice(0, 700) + '…' : draft.caption}\n\n` +
        `📅 Scheduled to send to you: ${when}`;

      const channel = await requireBrandChannel(brand.id);
      if (channel.capabilities.supportsImageWithButtons) {
        await channel.sendImageWithButtons({
          imageUrl,
          bodyText: body,
          footer: 'Tap a button below',
          buttons: [
            { id: `approve_${draft.id}`, title: 'Approve' },
            { id: `edit_${draft.id}`, title: 'Edit' },
            { id: `reject_${draft.id}`, title: 'Reject' },
          ],
        });
      } else {
        // Capability fallback: send the image, then ask for a textual reply.
        await channel.sendImage(imageUrl, body);
        await channel.sendText(
          `Reply 'approve', 'edit', or 'reject' for draft ${draft.id}.`,
        );
      }
      await updateDraftStatus(draft.id, 'pending_approval');

      await suspend({ draftId: draft.id });
      return undefined as never;
    }

    return {
      ...inputData,
      decision: resumeData.decision,
      ...(resumeData.editNote ? { editNote: resumeData.editNote } : {}),
    };
  },
});

const handleDecision = createStep({
  id: 'handle-decision',
  inputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    decision: decisionSchema,
    editNote: z.string().optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    finalDecision: decisionSchema,
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { brandId, draftId, scheduledAt, decision, editNote } = inputData;
    const brand = await findBrandById(brandId);
    if (!brand) throw new Error(`Brand ${brandId} not found`);
    const channel = await requireBrandChannel(brandId);

    if (decision === 'approve') {
      await updateDraftStatus(draftId, 'approved');
      const boss = await getBoss();
      await boss.send(
        QUEUES.deliverApprovedPost,
        { draftId, brandId },
        { startAfter: new Date(scheduledAt) },
      );
      const when = new Date(scheduledAt).toLocaleString('en-US', { timeZone: brand.timezone });
      await channel.sendText(
        `Locked in 🔒 — I'll send the final post back to you on ${when} so you can publish it.`,
      );
      logger.info({ draftId, brandId, scheduledAt }, 'Draft approved and delivery scheduled');
      return { brandId, draftId, scheduledAt, finalDecision: decision };
    }

    if (decision === 'reject') {
      await updateDraftStatus(draftId, 'rejected');
      await channel.sendText(
        `No worries — tossed that one. I'll come back with a different angle next time.`,
      );
      return { brandId, draftId, scheduledAt, finalDecision: decision };
    }

    // edit: record the note, ask for direction if missing, and signal a regeneration.
    const note = editNote?.trim() || '';
    if (note) {
      await appendEditNote(draftId, { at: new Date().toISOString(), note });
    }
    const briefingHint = note || 'The user wants this post revised. Try a fresh angle.';
    await channel.sendText("On it — taking another swing now ✏️");
    return {
      brandId,
      draftId,
      scheduledAt,
      finalDecision: decision,
      briefingHint,
      existingDraftId: draftId,
    };
  },
});

/**
 * Inner loop: generate → ask → handle. We dountil the decision is no longer 'edit'.
 * Once it's 'approve' or 'reject' the loop exits and the workflow finishes.
 */
const reviseLoop = createWorkflow({
  id: 'postDraftApproval.reviseLoop',
  inputSchema: z.object({
    brandId: z.string(),
    scheduledAt: z.string(),
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    finalDecision: decisionSchema,
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
  }),
})
  .then(generate)
  .then(requestApproval)
  .then(handleDecision)
  .commit();

export const postDraftApprovalWorkflow = createWorkflow({
  id: 'postDraftApproval',
  inputSchema: z.object({
    brandId: z.string(),
    scheduledAt: z.string(),
    briefingHint: z.string().optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    finalDecision: decisionSchema,
  }),
})
  .dountil(reviseLoop, async ({ inputData }) => inputData.finalDecision !== 'edit')
  .commit();
