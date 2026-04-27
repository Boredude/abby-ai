import { describe, expect, it, vi } from 'vitest';
import { makeMockBoundChannel } from '../helpers/mockChannel.js';

const fullCapsBound = makeMockBoundChannel('15558889999');
const noButtonsBound = makeMockBoundChannel('15558889999', {
  supportsText: true,
  supportsImages: true,
  supportsButtons: false,
  supportsImageWithButtons: false,
  maxButtonCount: 0,
  maxBodyChars: 1600,
});

let activeBound = fullCapsBound;

vi.mock('../../src/channels/registry.js', () => ({
  requireBrandChannel: vi.fn(async () => activeBound),
}));

import { sendChannelMessageTool } from '../../src/mastra/tools/sendChannelMessage.js';

type Execute = NonNullable<typeof sendChannelMessageTool.execute>;
const exec = sendChannelMessageTool.execute as Execute;

async function run(input: Parameters<Execute>[0]) {
  return exec(input, {} as Parameters<Execute>[1]);
}

describe('sendChannelMessage tool', () => {
  it('sends plain text on the resolved bound channel', async () => {
    activeBound = fullCapsBound;
    fullCapsBound.sendText.mockClear();
    const result = await run({
      brandId: 'brand-1',
      type: 'text',
      body: 'Hi from Duffy',
    });
    expect(fullCapsBound.sendText).toHaveBeenCalledWith('Hi from Duffy');
    expect(result).toEqual({ sent: true, type: 'text', channelKind: 'whatsapp' });
  });

  it('sends an image with caption', async () => {
    activeBound = fullCapsBound;
    fullCapsBound.sendImage.mockClear();
    await run({
      brandId: 'brand-1',
      type: 'image',
      imageUrl: 'https://example.com/img.png',
      body: 'Look at this',
    });
    expect(fullCapsBound.sendImage).toHaveBeenCalledWith('https://example.com/img.png', 'Look at this');
  });

  it('sends interactive buttons natively when supported', async () => {
    activeBound = fullCapsBound;
    fullCapsBound.sendButtons.mockClear();
    fullCapsBound.sendText.mockClear();
    await run({
      brandId: 'brand-1',
      type: 'buttons',
      body: 'Pick one:',
      buttons: [
        { id: 'a', title: 'Approve' },
        { id: 'b', title: 'Edit' },
      ],
    });
    expect(fullCapsBound.sendButtons).toHaveBeenCalledTimes(1);
    expect(fullCapsBound.sendText).not.toHaveBeenCalled();
  });

  it('falls back to numbered text when channel does not support buttons', async () => {
    activeBound = noButtonsBound;
    noButtonsBound.sendButtons.mockClear();
    noButtonsBound.sendText.mockClear();
    await run({
      brandId: 'brand-1',
      type: 'buttons',
      body: 'Pick one:',
      buttons: [
        { id: 'a', title: 'Approve' },
        { id: 'b', title: 'Edit' },
      ],
    });
    expect(noButtonsBound.sendButtons).not.toHaveBeenCalled();
    const sentText = noButtonsBound.sendText.mock.calls[0]?.[0] as string;
    expect(sentText).toContain('1. Approve');
    expect(sentText).toContain('2. Edit');
  });

  it('sends imageWithButtons natively when supported', async () => {
    activeBound = fullCapsBound;
    fullCapsBound.sendImageWithButtons.mockClear();
    fullCapsBound.sendImage.mockClear();
    await run({
      brandId: 'brand-1',
      type: 'imageWithButtons',
      imageUrl: 'https://example.com/img.png',
      body: 'Approve this draft?',
      buttons: [
        { id: 'a', title: 'Approve' },
        { id: 'r', title: 'Reject' },
      ],
    });
    expect(fullCapsBound.sendImageWithButtons).toHaveBeenCalledTimes(1);
    expect(fullCapsBound.sendImage).not.toHaveBeenCalled();
  });

  it('rejects buttons message without buttons array', async () => {
    activeBound = fullCapsBound;
    await expect(
      run({ brandId: 'brand-1', type: 'buttons', body: 'no buttons' }),
    ).rejects.toThrow(/at least 1 button/);
  });

  it('rejects image message without imageUrl', async () => {
    activeBound = fullCapsBound;
    await expect(run({ brandId: 'brand-1', type: 'image' })).rejects.toThrow(/imageUrl/);
  });
});
