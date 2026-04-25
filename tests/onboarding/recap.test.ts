import { describe, expect, it } from 'vitest';
import {
  buildBrandKitRecap,
  isExplicitApproval,
  looksLikeHandle,
} from '../../src/services/onboarding/recap.js';
import type { Brand } from '../../src/db/schema.js';

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  const now = new Date();
  return {
    id: 'b1',
    waPhone: '+10000000000',
    igHandle: 'ob.cocktails',
    voiceJson: {
      summary: 'Playful, neighborhood cocktail bar with a craft edge.',
      tone: ['playful', 'warm', 'confident'],
      audience: 'Tel Aviv locals 25–40 looking for a relaxed night out.',
      do: ['be witty'],
      dont: ['be stuffy'],
      emojiUsage: 'sparing',
      hashtagPolicy: 'A couple of niche tags max.',
    },
    cadenceJson: null,
    brandKitJson: {
      palette: [
        { hex: '#1A1A1A', role: 'primary', name: 'Charcoal' },
        { hex: '#D4A24C', role: 'accent', name: 'Brass' },
      ],
      typography: { mood: 'classic serif with a modern bite' },
    },
    designSystemJson: {
      photoStyle: 'Moody, low-light bar photography with warm highlights.',
      illustrationStyle: 'Minimal',
      composition: 'Centered',
      lighting: 'Low warm',
      recurringMotifs: ['glassware'],
      doVisuals: ['Show garnishes up close'],
      dontVisuals: ['Avoid harsh flash'],
    },
    igAnalysisJson: null,
    timezone: 'Asia/Jerusalem',
    status: 'onboarding',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Brand;
}

describe('buildBrandKitRecap', () => {
  it('renders palette, voice, and visual cues', () => {
    const text = buildBrandKitRecap(makeBrand());
    expect(text).toContain('@ob.cocktails');
    expect(text).toContain('playful, warm, confident');
    expect(text).toContain('#1A1A1A');
    expect(text).toContain('Charcoal');
    expect(text).toMatch(/\*Do:\*/);
    expect(text).toMatch(/\*Don't:\*/);
  });

  it('omits empty sections gracefully', () => {
    const text = buildBrandKitRecap(
      makeBrand({ brandKitJson: null, designSystemJson: null }),
    );
    expect(text).toContain('@ob.cocktails');
    expect(text).not.toContain('*Palette:*');
    expect(text).not.toContain('*Visuals:*');
  });
});

describe('isExplicitApproval', () => {
  it.each([
    'yes',
    'Yes please',
    'lock it in',
    'looks good!',
    'sounds good',
    'perfect',
    'do it',
    'YES',
  ])('treats %s as approval', (input) => {
    expect(isExplicitApproval(input)).toBe(true);
  });

  it.each([
    'ob.cocktails',
    'make the palette warmer',
    'change the tone to be more formal',
    'no',
    "I'm not sure",
    '',
  ])('does NOT treat %s as approval', (input) => {
    expect(isExplicitApproval(input)).toBe(false);
  });
});

describe('looksLikeHandle', () => {
  it.each([
    'ob.cocktails',
    '@ob.cocktails',
    'nike',
    '@nike',
    'a_b.c1',
    'https://www.instagram.com/nike/',
    'https://instagram.com/nike',
    'instagram.com/nike',
    'www.instagram.com/nike/',
  ])('treats %s as a handle', (input) => {
    expect(looksLikeHandle(input)).toBe(true);
  });

  it.each([
    'make it more playful',
    'lock it in',
    'change the green to navy please',
    '',
    'a',
  ])('does NOT treat %s as a handle', (input) => {
    expect(looksLikeHandle(input)).toBe(false);
  });
});
