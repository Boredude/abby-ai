import { describe, expect, it } from 'vitest';
import { sanitizeUserFacingFromDuffy } from '../../src/mastra/agents/voice.js';

describe('sanitizeUserFacingFromDuffy', () => {
  it.each([
    undefined,
    '',
    '   ',
  ])('returns null for empty/blank input (%s)', (input) => {
    expect(sanitizeUserFacingFromDuffy(input)).toBeNull();
  });

  it('passes a clean, in-voice reply through unchanged', () => {
    const text = "Got it — I'll lean a bit more playful on the next pass.";
    expect(sanitizeUserFacingFromDuffy(text)).toBe(text);
  });

  it('trims surrounding whitespace on clean input', () => {
    const text = '  Locked in — onto the next step.  ';
    expect(sanitizeUserFacingFromDuffy(text)).toBe('Locked in — onto the next step.');
  });

  // Real leaks lifted from the bug report — the orchestrator narrating its
  // own plan and pasting plumbing into the user-facing channel.
  it.each([
    'I need to get the current brand context first to see what we\'re working with.',
    "Let me ask for clarity: what part of the brand kit did you want to adjust?",
    "First, I'll check the brand kit and then update it.",
    "I'll need to call updateBrandContext first.",
    "I should get the brand context before replying.",
    "Without a concrete tweak mentioned, I can't map this to voice/cadence/timezone.",
    "I see the brand kit is already built and locked in.",
    '"Yess!!" sounds like approval, not a request to change something specific.',
    '[brandId=11111111-1111-1111-1111-111111111111] applied the change.',
    'Calling updateBrandContext now.',
    'Pulling getBrandContext to see the latest state.',
    'fromPhone +15558889999 confirmed.',
    'Mapping to voice/cadence/timezone fields.',
  ])('suppresses leaked-reasoning / plumbing pattern: %s', (raw) => {
    expect(sanitizeUserFacingFromDuffy(raw)).toBeNull();
  });

  it('does not falsely suppress innocuous mentions of "I need" inside a sentence', () => {
    // The pattern is anchored to the start of the message — a real reply
    // that happens to contain "i need" mid-sentence should pass through.
    const text = "Sweet — happy with this version. Anything you need me to tweak before we ship?";
    expect(sanitizeUserFacingFromDuffy(text)).toBe(text);
  });
});
