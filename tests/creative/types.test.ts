import { describe, expect, it } from 'vitest';
import {
  artDirectionArtifactSchema,
  copyArtifactSchema,
  hashtagArtifactSchema,
  ideationArtifactSchema,
  imageArtifactSchema,
  postDraftGenerationSchema,
  stepArtifactInputSchema,
} from '../../src/services/creative/types.js';

describe('creative artifact schemas', () => {
  it('accepts a valid ideation artifact', () => {
    const parsed = ideationArtifactSchema.parse({
      topic: 'Summer menu launch',
      angle: 'A top-down slow-pour shot of the matcha spritz at golden hour.',
      themes: ['drinks', 'summer', 'ritual'],
      rationale: "Aligns with the brand's golden-hour moodboard and fresh-menu cadence.",
    });
    expect(parsed.topic).toBe('Summer menu launch');
    expect(parsed.themes).toHaveLength(3);
  });

  it('rejects an ideation artifact with too-short angle', () => {
    const res = ideationArtifactSchema.safeParse({
      topic: 'x',
      angle: 'too short',
      themes: [],
      rationale: 'r',
    });
    expect(res.success).toBe(false);
  });

  it('accepts a valid copy artifact', () => {
    const res = copyArtifactSchema.parse({
      hook: 'Pour slower.',
      body: "Our matcha spritz starts with a 45-second whisk, then the tonic, then the pour that hits the glass like a whisper.",
      cta: 'Tap by 6pm — the first pour is on us.',
      fullCaption:
        "Pour slower.\n\nOur matcha spritz starts with a 45-second whisk, then the tonic, then the pour that hits the glass like a whisper.\n\nTap by 6pm — the first pour is on us.",
    });
    expect(res.hook).toBe('Pour slower.');
  });

  it('accepts hashtags with or without leading #', () => {
    const res = hashtagArtifactSchema.parse({
      hashtags: ['matcha', '#ritual', 'slowpour'],
    });
    expect(res.hashtags).toHaveLength(3);
  });

  it('rejects hashtags containing spaces', () => {
    const res = hashtagArtifactSchema.safeParse({
      hashtags: ['matcha spritz'],
    });
    expect(res.success).toBe(false);
  });

  it('accepts a valid art-direction artifact', () => {
    const parsed = artDirectionArtifactSchema.parse({
      subject: 'Top-down pour shot of a matcha spritz',
      composition: 'Tight crop, glass centred, marble surface texture visible',
      lighting: 'Warm golden-hour diagonal, soft shadows',
      palette: ['#D4E3C2', '#F4E5C2', '#1A1A1A'],
      mood: 'Hushed, crisp, summer evening',
      imagePrompt:
        "A top-down photograph of a matcha spritz in a chunky coupe on a pale marble surface; warm golden-hour diagonal light; palette leaning sage, cream, and near-black; no text on the image; crisp, summer-evening mood.",
    });
    expect(parsed.size).toBe('1024x1536');
  });

  it('accepts a valid image artifact', () => {
    const parsed = imageArtifactSchema.parse({
      url: 'https://media.example.com/images/brand/draft-xyz.png',
      key: 'images/brand/draft-xyz.png',
      prompt: 'anything',
    });
    expect(parsed.url).toContain('media.example.com');
  });

  it('stepArtifactInputSchema is a discriminated union by step', () => {
    const good = stepArtifactInputSchema.parse({
      step: 'hashtags',
      artifact: { hashtags: ['one', '#two'] },
    });
    expect(good.step).toBe('hashtags');

    // Mis-matched step + artifact should fail (copy artifact sent as step="image").
    const bad = stepArtifactInputSchema.safeParse({
      step: 'image',
      artifact: { hook: 'h', body: 'b', cta: 'c', fullCaption: 'long enough caption text here for validation purposes' },
    });
    expect(bad.success).toBe(false);
  });

  it('postDraftGenerationSchema parses an empty default shape', () => {
    const parsed = postDraftGenerationSchema.parse({ contentTypeId: 'igSinglePost' });
    expect(parsed.steps).toEqual({});
    expect(parsed.editHistory).toEqual([]);
  });
});
