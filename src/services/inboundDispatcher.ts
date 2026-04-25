import { logger } from '../config/logger.js';
import { upsertBrandByPhone } from '../db/repositories/brands.js';
import { findActiveRunForBrand, findRunByDraft } from '../db/repositories/workflowRuns.js';
import { getAbbyAgent } from '../mastra/agents/abby.js';
import { sendText } from './kapso/client.js';
import type { ParsedInboundMessage } from './kapso/inboundParser.js';
import { handleSlashCommand, isSlashCommand } from './slashCommands.js';
import { resumeWorkflow, startWorkflow } from './workflowRunner.js';

function memoryFor(brandId: string): { thread: string; resource: string } {
  return { thread: `brand:${brandId}`, resource: brandId };
}

function buildUserPrompt(parsed: ParsedInboundMessage, brandId: string): string {
  const meta = `[brandId=${brandId} fromPhone=${parsed.fromPhone}]`;
  switch (parsed.kind) {
    case 'text':
      return `${meta}\n${parsed.text}`;
    case 'button':
      return `${meta}\n(The user tapped a WhatsApp button: id=${parsed.buttonId} title="${parsed.buttonTitle}")`;
    case 'image':
      return `${meta}\n(The user sent an image. mediaId=${parsed.mediaId})${
        parsed.caption ? ` Caption: ${parsed.caption}` : ''
      }`;
    case 'unsupported':
      return `${meta}\n(The user sent an unsupported message type: ${parsed.rawType})`;
  }
}

/**
 * Extracts a free-text reply from any inbound message kind so it can be fed
 * to a suspended workflow's `resumeSchema: { reply: string }`.
 */
function extractReplyText(parsed: ParsedInboundMessage): string {
  switch (parsed.kind) {
    case 'text':
      return parsed.text;
    case 'button':
      return parsed.buttonTitle || parsed.buttonId;
    case 'image':
      return parsed.caption ?? '';
    case 'unsupported':
      return '';
  }
}

/**
 * Different workflows expect different resume shapes:
 *  - brandOnboarding: { reply: string }
 *  - postDraftApproval: { decision: 'approve'|'edit'|'reject', editNote?: string }
 *
 * For the approval flow we map button taps -> decision; if the user replies
 * with text instead of tapping a button, we treat it as an `edit` with that
 * text as the note.
 */
function buildResumeDataFor(workflowId: string, parsed: ParsedInboundMessage): Record<string, unknown> {
  if (workflowId === 'postDraftApproval') {
    if (parsed.kind === 'button' && parsed.decision) {
      return { decision: parsed.decision };
    }
    if (parsed.kind === 'text') {
      return { decision: 'edit', editNote: parsed.text };
    }
    return { decision: 'edit', editNote: extractReplyText(parsed) };
  }
  return { reply: extractReplyText(parsed) };
}

/**
 * Dispatches an inbound WhatsApp message:
 *  1. If a Mastra workflow run is suspended for this brand (or the specific
 *     draft a button refers to), resume it with the user's reply.
 *  2. Otherwise, if the brand is brand-new (status pending), start the
 *     brandOnboarding workflow.
 *  3. Otherwise, hand off to the Abby agent for free-form chat.
 */
export async function dispatchInboundMessage(parsed: ParsedInboundMessage): Promise<void> {
  // Slash commands run before any brand/workflow plumbing so they can wipe
  // state cleanly (e.g. `/reset` deletes the brand row entirely).
  if (isSlashCommand(parsed)) {
    await handleSlashCommand(parsed);
    return;
  }

  const brand = await upsertBrandByPhone({ waPhone: parsed.fromPhone });
  const log = logger.child({ brandId: brand.id, fromPhone: parsed.fromPhone, kind: parsed.kind });
  log.info('Inbound message received');

  let activeRun = null;
  if (parsed.kind === 'button' && parsed.draftId) {
    activeRun = await findRunByDraft(parsed.draftId);
  }
  if (!activeRun) {
    activeRun = await findActiveRunForBrand(brand.id);
  }

  if (activeRun) {
    log.info({ runId: activeRun.runId, workflowId: activeRun.workflowId }, 'Resuming workflow');
    try {
      const resumeData = buildResumeDataFor(activeRun.workflowId, parsed);
      await resumeWorkflow({
        workflowId: activeRun.workflowId as 'brandOnboarding' | 'postDraftApproval',
        runId: activeRun.runId,
        brandId: brand.id,
        ...(activeRun.draftId ? { draftId: activeRun.draftId } : {}),
        resumeData,
      });
    } catch (err) {
      log.error({ err, runId: activeRun.runId }, 'Failed to resume workflow');
      await sendText(parsed.fromPhone, "Sorry, something went off the rails on my side. Mind sending that one more time?");
    }
    return;
  }

  if (brand.status === 'pending') {
    log.info('Starting brandOnboarding for new brand');
    try {
      await startWorkflow({
        workflowId: 'brandOnboarding',
        brandId: brand.id,
        inputData: { brandId: brand.id },
      });
    } catch (err) {
      log.error({ err }, 'Failed to start brandOnboarding');
      await sendText(parsed.fromPhone, "Hey! I'm Abby. I had a small hiccup starting up — give me a minute and try again?");
    }
    return;
  }

  // Already-onboarded brand: free chat with the agent.
  const agent = getAbbyAgent();
  const prompt = buildUserPrompt(parsed, brand.id);

  let reply: string;
  try {
    const result = await agent.generate(prompt, { memory: memoryFor(brand.id) });
    reply = (result as { text?: string }).text?.trim() ?? '';
  } catch (err) {
    log.error({ err }, 'Abby agent generate failed');
    reply = 'Sorry, I hit a snag on my end. Mind sending that again in a moment?';
  }

  if (reply) {
    await sendText(parsed.fromPhone, reply);
  }
}
