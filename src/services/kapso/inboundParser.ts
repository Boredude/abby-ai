import type { ChannelMessage } from '../../channels/types.js';
import type { KapsoMessageReceivedEvent } from './types.js';

/**
 * Decodes a button payload of the form `approve_<draftId>` / `edit_<draftId>` / `reject_<draftId>`.
 */
export function decodeButtonId(buttonId: string): { decision?: 'approve' | 'edit' | 'reject'; draftId?: string } {
  const parts = buttonId.split('_');
  if (parts.length < 2) return {};
  const head = parts[0];
  const draftId = parts.slice(1).join('_');
  if (head === 'approve' || head === 'edit' || head === 'reject') {
    return { decision: head, draftId };
  }
  return {};
}

/**
 * Translates a raw Kapso webhook payload into the channel-agnostic
 * `ChannelMessage` the dispatcher works on. Returns `null` for payloads we
 * can't decode at all (no message id / no sender) so the webhook route can
 * 200-ack and ignore.
 */
export function parseKapsoEvent(event: KapsoMessageReceivedEvent): ChannelMessage | null {
  const m = event.message;
  if (!m?.id || !m?.from) return null;

  const base = {
    channelKind: 'whatsapp' as const,
    externalUserId: m.from,
    externalMessageId: m.id,
    ...(event.conversation?.contact_name ? { contactName: event.conversation.contact_name } : {}),
    ...(event.conversation?.id ? { conversationId: event.conversation.id } : {}),
  };

  switch (m.type) {
    case 'text': {
      const text = (m as { text?: { body?: string } }).text?.body ?? '';
      return { ...base, kind: 'text', text };
    }
    case 'interactive': {
      const reply = (m as { interactive?: { button_reply?: { id?: string; title?: string } } })
        .interactive?.button_reply;
      if (!reply?.id) return null;
      const decoded = decodeButtonId(reply.id);
      return {
        ...base,
        kind: 'button',
        buttonId: reply.id,
        buttonTitle: reply.title ?? '',
        ...(decoded.decision ? { decision: decoded.decision } : {}),
        ...(decoded.draftId ? { draftId: decoded.draftId } : {}),
      };
    }
    case 'image': {
      const img = (m as { image?: { id?: string; mime_type?: string; caption?: string; link?: string } }).image;
      if (!img?.id) return null;
      return {
        ...base,
        kind: 'image',
        mediaId: img.id,
        ...(img.mime_type ? { mimeType: img.mime_type } : {}),
        ...(img.caption ? { caption: img.caption } : {}),
        ...(img.link ? { mediaLink: img.link } : {}),
      };
    }
    default:
      return { ...base, kind: 'unsupported', rawType: m.type };
  }
}
