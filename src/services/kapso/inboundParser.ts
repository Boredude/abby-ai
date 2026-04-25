import type { KapsoMessageReceivedEvent } from './types.js';

export type ParsedInboundMessage = {
  waMessageId: string;
  fromPhone: string;
  contactName?: string;
  conversationId?: string;
} & (
  | { kind: 'text'; text: string }
  | {
      kind: 'button';
      buttonId: string;
      buttonTitle: string;
      decision?: 'approve' | 'edit' | 'reject';
      draftId?: string;
    }
  | { kind: 'image'; mediaId: string; mimeType?: string; caption?: string; mediaLink?: string }
  | { kind: 'unsupported'; rawType: string }
);

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

export function parseKapsoEvent(event: KapsoMessageReceivedEvent): ParsedInboundMessage | null {
  const m = event.message;
  if (!m?.id || !m?.from) return null;

  const base = {
    waMessageId: m.id,
    fromPhone: m.from,
    ...(event.conversation?.contact_name ? { contactName: event.conversation.contact_name } : {}),
    ...(event.conversation?.id ? { conversationId: event.conversation.id } : {}),
  } as const;

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
