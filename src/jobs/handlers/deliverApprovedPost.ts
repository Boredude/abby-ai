import { logger } from '../../config/logger.js';
import { findBrandById } from '../../db/repositories/brands.js';
import { findDraftById, updateDraftStatus } from '../../db/repositories/postDrafts.js';
import { sendImage, sendText } from '../../services/kapso/client.js';

export type DeliverApprovedPostPayload = {
  draftId: string;
  brandId: string;
};

/**
 * pg-boss handler: at the scheduled time, send the approved post (caption +
 * image) back to the brand on WhatsApp so they can publish it manually.
 *
 * MVP scope: Duffy does NOT post to Instagram herself yet — she just delivers
 * the asset to the brand owner.
 */
export async function handleDeliverApprovedPost(payload: DeliverApprovedPostPayload): Promise<void> {
  const { draftId } = payload;
  const draft = await findDraftById(draftId);
  if (!draft) {
    logger.warn({ draftId }, 'deliverApprovedPost: draft not found');
    return;
  }
  if (draft.status !== 'approved') {
    logger.warn({ draftId, status: draft.status }, 'deliverApprovedPost: draft not approved, skipping');
    return;
  }
  const brand = await findBrandById(draft.brandId);
  if (!brand) {
    logger.warn({ draftId, brandId: draft.brandId }, 'deliverApprovedPost: brand not found');
    return;
  }
  const imageUrl = draft.mediaUrls[0];
  if (!imageUrl) {
    logger.warn({ draftId }, 'deliverApprovedPost: no image URL on draft');
    return;
  }

  await sendText(
    brand.waPhone,
    `📣 Time to post! Here's your approved content for @${brand.igHandle ?? 'your brand'}.\n\nCopy the caption below and pair it with the image I'm sending right after.`,
  );
  await sendText(brand.waPhone, draft.caption);
  await sendImage(brand.waPhone, imageUrl, 'Use this image with the caption above ☝️');

  await updateDraftStatus(draftId, 'delivered');
  logger.info({ draftId, brandId: brand.id }, 'deliverApprovedPost: delivered');
}
