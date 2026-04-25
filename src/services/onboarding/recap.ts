import type { Brand } from '../../db/schema.js';

/**
 * Deterministic WhatsApp-friendly recap of a brand's saved kit, voice, and
 * design system. Built from DB state so the user always sees the conclusions
 * — independent of whatever Abby's chat reply happens to contain.
 */
export function buildBrandKitRecap(brand: Brand): string {
  const handle = brand.igHandle ?? 'your brand';
  const voice = brand.voiceJson;
  const kit = brand.brandKitJson;
  const ds = brand.designSystemJson;

  const lines: string[] = [];
  lines.push(`Here's what I picked up from @${handle}:`);
  lines.push('');

  if (voice?.summary) {
    lines.push(voice.summary.trim());
    lines.push('');
  }

  if (voice?.tone?.length) {
    lines.push(`*Voice:* ${voice.tone.slice(0, 3).join(', ')}`);
  }

  if (voice?.audience) {
    lines.push(`*Audience:* ${voice.audience}`);
  }

  if (kit?.palette?.length) {
    const palette = kit.palette
      .slice(0, 5)
      .map((p) => (p.name ? `${p.hex} (${p.name})` : p.hex))
      .join(', ');
    lines.push(`*Palette:* ${palette}`);
  }

  if (ds?.photoStyle) {
    lines.push(`*Visuals:* ${truncate(ds.photoStyle, 140)}`);
  }

  if (ds?.doVisuals?.length) {
    lines.push(`*Do:* ${ds.doVisuals.slice(0, 2).join(' • ')}`);
  }
  if (ds?.dontVisuals?.length) {
    lines.push(`*Don't:* ${ds.dontVisuals.slice(0, 2).join(' • ')}`);
  }

  if (voice?.emojiUsage) {
    lines.push(`*Emoji:* ${voice.emojiUsage}`);
  }
  if (voice?.hashtagPolicy) {
    lines.push(`*Hashtags:* ${truncate(voice.hashtagPolicy, 80)}`);
  }

  return lines.join('\n').trim();
}

export const REVIEW_PROMPT =
  "How does this look? Reply *YES* to lock it in, tell me what to tweak (e.g. \"more playful\", \"swap the green for navy\"), or send a different handle to try.";

export const RETRY_HANDLE_PROMPT =
  "Hmm, I couldn't read that account — make sure it's public and the handle is right. Send the handle again (without the @) and I'll retry.";

/** True if the reply is an explicit, unambiguous approval. */
export function isExplicitApproval(reply: string): boolean {
  const lower = reply.trim().toLowerCase();
  if (!lower) return false;
  if (lower.length > 40) return false; // edits tend to be longer sentences
  // Negations like "not sure" / "no thanks" should never count as approval.
  if (/\b(no|not|don'?t|nope|nah)\b/.test(lower)) return false;
  return /\b(yes|yep|yeah|yup|ok(ay)?|lock(ed)?( it)?( in)?|confirm(ed)?|approve(d)?|perfect|great|sounds good|looks good|love it|do it|let's go|go for it)\b/.test(
    lower,
  );
}

/**
 * True if the reply plausibly is an Instagram handle the user wants to try —
 * either a single token (letters/digits/dot/underscore, optional `@`) or an
 * instagram.com URL. Used to detect "user wants to retry with a different
 * handle" instead of misreading it as approval or edit feedback.
 */
export function looksLikeHandle(reply: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return false;
  if (/^@?[a-zA-Z0-9._]{2,30}$/.test(trimmed)) return true;
  // Accept IG URL forms.
  if (/^(https?:\/\/)?(www\.|m\.)?instagram\.com\/[a-zA-Z0-9._/?=&-]+/i.test(trimmed)) {
    return true;
  }
  return false;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
