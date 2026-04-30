import type { Brand } from '../../db/schema.js';

/**
 * Deterministic WhatsApp-friendly recap of a brand's saved kit, voice, and
 * design system. Built from DB state so the user always sees the conclusions
 * — independent of whatever Duffy's chat reply happens to contain.
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

// Short emoji-only confirmations (👍, 🙌🎉, etc.). Capped at 3 emojis so a
// long emoji wall doesn't accidentally qualify as approval.
const APPROVAL_EMOJI_RE =
  /^\s*(?:👍|👌|🙌|🎉|💯|✅|🔒|🔥|🥰|🤩|❤️?){1,3}\s*$/u;

// Approval tokens, with elongation tolerated on the short ones so emphatic
// WhatsApp replies match (yess, yesss, yeahhh, yupp, okk, okayyy, ...).
const APPROVAL_WORD_RE =
  /\b(?:y+e+s+|y+e+p+|y+e+a+h+|y+u+p+|y+a+s+|y+a+y+|ok+(?:ay+)?|perfect+|great+|love\s+it|sounds\s+good|looks\s+good|do\s+it|lock(?:ed)?(?:\s+it)?(?:\s+in)?|confirm(?:ed)?|approve(?:d)?|lgtm|lfg|let'?s\s+go|go\s+for\s+it)\b/;

// Negations always disqualify ("no", "not sure", "don't", ...).
const NEGATION_RE = /\b(?:no|not|don'?t|nope|nah)\b/;

// Mixed-intent markers: presence means the reply isn't a pure approval, even
// if it contains an approval word. Covers conjunctions ("yes but more playful")
// and tweak verbs ("yes swap the green", "perfect, make it punchier").
const MIXED_INTENT_RE =
  /\b(?:but|however|except|though|although|swap|change|tweak|modify|replace|switch|make)\b/;

/**
 * True if the reply is an explicit, unambiguous approval.
 *
 * Tolerates the kind of emphasis people actually send on WhatsApp:
 * elongated letters ("Yess!!", "yeahhh"), exclamation marks, and a single
 * approval emoji. Anything that mixes approval with a tweak request
 * ("yes but more playful", "perfect, change the green") is rejected so the
 * caller routes it to the LLM intent classifier instead.
 */
export function isExplicitApproval(reply: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return false;
  if (trimmed.length > 40) return false; // edits tend to be longer sentences
  if (APPROVAL_EMOJI_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (NEGATION_RE.test(lower)) return false;
  if (MIXED_INTENT_RE.test(lower)) return false;
  return APPROVAL_WORD_RE.test(lower);
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
