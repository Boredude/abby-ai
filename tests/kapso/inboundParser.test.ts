import { describe, expect, it } from 'vitest';
import { decodeButtonId, parseKapsoEvent } from '../../src/services/kapso/inboundParser.js';
import type { KapsoMessageReceivedEvent } from '../../src/services/kapso/types.js';

describe('decodeButtonId', () => {
  it('decodes approve_<draftId>', () => {
    expect(decodeButtonId('approve_abc-123')).toEqual({ decision: 'approve', draftId: 'abc-123' });
  });

  it('decodes edit and reject', () => {
    expect(decodeButtonId('edit_d').decision).toBe('edit');
    expect(decodeButtonId('reject_d').decision).toBe('reject');
  });

  it('returns empty for unknown payloads', () => {
    expect(decodeButtonId('hello')).toEqual({});
    expect(decodeButtonId('foo_bar')).toEqual({});
  });

  it('preserves draft ids that contain underscores', () => {
    expect(decodeButtonId('approve_abc_def')).toEqual({ decision: 'approve', draftId: 'abc_def' });
  });
});

describe('parseKapsoEvent', () => {
  it('parses a text message into a whatsapp ChannelMessage', () => {
    const event: KapsoMessageReceivedEvent = {
      message: { id: 'wamid.1', from: '15551234567', type: 'text', text: { body: 'hi duffy' } },
      conversation: { id: 'conv-1', contact_name: 'Tester' },
    };
    expect(parseKapsoEvent(event)).toEqual({
      channelKind: 'whatsapp',
      externalUserId: '15551234567',
      externalMessageId: 'wamid.1',
      contactName: 'Tester',
      conversationId: 'conv-1',
      kind: 'text',
      text: 'hi duffy',
    });
  });

  it('parses an interactive button reply', () => {
    const event: KapsoMessageReceivedEvent = {
      message: {
        id: 'wamid.2',
        from: '15551234567',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'approve_draft-abc', title: 'Approve' },
        },
      } as never,
    };
    const parsed = parseKapsoEvent(event);
    expect(parsed?.kind).toBe('button');
    expect(parsed?.channelKind).toBe('whatsapp');
    expect(parsed && parsed.kind === 'button' && parsed.decision).toBe('approve');
    expect(parsed && parsed.kind === 'button' && parsed.draftId).toBe('draft-abc');
  });

  it('returns unsupported for message types we do not handle', () => {
    const event: KapsoMessageReceivedEvent = {
      message: { id: 'wamid.3', from: '15551234567', type: 'sticker' } as never,
    };
    const parsed = parseKapsoEvent(event);
    expect(parsed?.kind).toBe('unsupported');
  });

  it('returns null when message is missing', () => {
    const event = {} as KapsoMessageReceivedEvent;
    expect(parseKapsoEvent(event)).toBeNull();
  });
});
