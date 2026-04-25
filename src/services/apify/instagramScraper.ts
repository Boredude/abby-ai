import { ApifyClient } from 'apify-client';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Thin wrapper around Apify's `apify/instagram-scraper` actor.
 *
 * We always use `resultsType: 'details'` because that mode embeds `latestPosts`
 * inline, giving us the full profile + recent posts in a single dataset row.
 */

const ACTOR_ID = 'apify/instagram-scraper';

export type InstagramProfile = {
  username: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  profilePicUrl?: string;
  profilePicUrlHD?: string;
  isVerified?: boolean;
  isBusinessAccount?: boolean;
  externalUrl?: string;
  url: string;
};

export type InstagramPost = {
  id: string;
  type: 'Image' | 'Sidecar' | 'Video' | string;
  shortCode: string;
  url: string;
  caption: string;
  /** Best image URL for this post (the first frame for sidecars/videos). */
  imageUrl: string;
  /** All image frames if this was a sidecar; otherwise just the cover image. */
  images: string[];
  likesCount?: number;
  commentsCount?: number;
  timestamp?: string;
  isPinned?: boolean;
  alt?: string;
  mentions?: string[];
};

export type InstagramScrapeResult = {
  profile: InstagramProfile;
  posts: InstagramPost[];
};

export class InstagramScraperError extends Error {
  constructor(
    public readonly code: 'not_found' | 'private' | 'empty' | 'rate_limited' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'InstagramScraperError';
  }
}

let cachedClient: ApifyClient | null = null;

function getClient(): ApifyClient {
  if (cachedClient) return cachedClient;
  const env = loadEnv();
  cachedClient = new ApifyClient({ token: env.APIFY_TOKEN });
  return cachedClient;
}

/**
 * Coerce whatever the user typed into a bare Instagram username:
 *   `@nike`                              → nike
 *   `nike`                               → nike
 *   `Nike/`                              → nike
 *   `https://www.instagram.com/nike`     → nike
 *   `https://www.instagram.com/nike/?hl=en` → nike
 *   `instagram.com/nike/p/Abc123/`       → nike
 *   `https://m.instagram.com/_/nike/`    → nike
 * Throws if no valid username can be extracted.
 */
export function normalizeIgHandle(input: string): string {
  if (typeof input !== 'string') {
    throw new InstagramScraperError('not_found', 'Invalid Instagram handle: not a string');
  }
  let raw = input.trim();
  if (!raw) {
    throw new InstagramScraperError('not_found', `Invalid Instagram handle: "${input}"`);
  }

  // If it looks like a URL or has an instagram.com host, parse as URL.
  const looksLikeUrl = /^https?:\/\//i.test(raw) || /(^|[^\w])instagram\.com\//i.test(raw);
  if (looksLikeUrl) {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
      url = new URL(withProtocol);
    } catch {
      throw new InstagramScraperError('not_found', `Invalid Instagram URL: "${input}"`);
    }
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) {
      throw new InstagramScraperError(
        'not_found',
        `Not an instagram.com URL: "${input}"`,
      );
    }
    // The username must be the FIRST path segment; anything else (e.g. /p/,
    // /reel/, /explore/) is an IG-internal route, not a profile.
    const reserved = new Set([
      'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct',
      'web', 'about', 'developer', 'legal', 'press', '_u',
    ]);
    const segments = url.pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (!first || reserved.has(first.toLowerCase())) {
      throw new InstagramScraperError(
        'not_found',
        `Could not find a username in URL: "${input}"`,
      );
    }
    raw = first;
  }

  const trimmed = raw.trim().replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
  if (!trimmed || /\s/.test(trimmed) || !/^[a-z0-9._]+$/.test(trimmed)) {
    throw new InstagramScraperError('not_found', `Invalid Instagram handle: "${input}"`);
  }
  return trimmed;
}

/**
 * Tolerant handle extraction for free-form replies.
 *
 * Real users don't always send the handle as a clean isolated message — they
 * write things like `"Oh got it. @ob.cocktails"` or
 * `"my handle is instagram.com/ob.cocktails"`. The strict `normalizeIgHandle`
 * rejects those because the whole reply isn't a handle. This helper:
 *
 *   1. Tries the whole reply first (covers `nike`, `@nike`, `instagram.com/nike`).
 *   2. Otherwise scans the reply for a strong signal — an explicit `@handle`
 *      token or an `instagram.com/...` URL — and normalizes the first match.
 *
 * We deliberately do NOT extract bare word tokens (e.g. picking `nike` out of
 * "I love nike") because that's ambiguous and would hijack regular chat. An
 * explicit `@` or URL is required for embedded extraction.
 *
 * Returns the normalized username, or `null` if nothing usable was found.
 */
/**
 * Common single-word replies that happen to match the IG username character
 * set but are clearly NOT handles in conversation (acknowledgments,
 * confusion, refusals, greetings). Prevents the whole-message normalize step
 * from misreading "Yea" or "ok" as a handle. The LLM extractor catches a much
 * wider net; this is just for the regex fallback path.
 */
const NON_HANDLE_WORDS = new Set([
  'yes', 'yea', 'yeah', 'yep', 'yup', 'ok', 'okay', 'cool', 'sure', 'sweet',
  'no', 'nope', 'nah', 'never',
  'hi', 'hey', 'hello', 'sup', 'lol', 'haha', 'hmm', 'wat', 'what', 'huh',
  'k', 'kk', 'thx', 'thanks', 'ty', 'np', 'ok', 'idk', 'tbh', 'fr', 'oof',
  'maybe', 'later', 'skip', 'wait', 'stop', 'pause', 'go', 'now', 'soon',
  'me', 'you', 'us', 'them', 'this', 'that', 'these', 'those',
]);

export function extractHandleFromMessage(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (NON_HANDLE_WORDS.has(trimmed.toLowerCase())) {
    return null;
  }

  try {
    return normalizeIgHandle(trimmed);
  } catch {
    // Fall through to embedded extraction.
  }

  // Strongest signal: an explicit @handle token. IG usernames are 1–30 chars
  // of [a-zA-Z0-9._]. We require the @ to be at a word boundary so we don't
  // pick up email addresses (e.g. `@gmail` in `me@gmail.com`).
  const atMatch = trimmed.match(/(?:^|[\s(,;:!?'"`])@([a-zA-Z0-9._]{1,30})/);
  if (atMatch && atMatch[1]) {
    try {
      return normalizeIgHandle(atMatch[1]);
    } catch {
      // Fall through.
    }
  }

  // Next strongest signal: an instagram.com URL anywhere in the reply.
  const urlMatch = trimmed.match(/(https?:\/\/)?(?:www\.|m\.)?instagram\.com\/[a-zA-Z0-9._/?=&-]+/i);
  if (urlMatch) {
    try {
      return normalizeIgHandle(urlMatch[0]);
    } catch {
      // Fall through.
    }
  }

  return null;
}

export type FetchInstagramProfileOptions = {
  /** Cap on how many posts we want to keep after the actor returns. */
  postsLimit?: number;
  /** Override the default actor timeout (seconds). */
  timeoutSecs?: number;
};

/**
 * Fetch an IG profile + its `latestPosts` via the Apify scraper actor.
 * Returns a normalized shape; on a missing/private/empty profile we throw a
 * typed `InstagramScraperError` so callers can branch on the failure mode.
 */
export async function fetchInstagramProfile(
  rawHandle: string,
  options: FetchInstagramProfileOptions = {},
): Promise<InstagramScrapeResult> {
  const handle = normalizeIgHandle(rawHandle);
  const profileUrl = `https://www.instagram.com/${handle}/`;
  const log = logger.child({ scraper: 'apify-ig', handle });

  log.info({ actor: ACTOR_ID }, 'Calling Apify Instagram scraper');
  const client = getClient();

  const callOptions: { timeout?: number } = {};
  if (options.timeoutSecs) callOptions.timeout = options.timeoutSecs;

  let run;
  try {
    run = await client.actor(ACTOR_ID).call(
      {
        directUrls: [profileUrl],
        resultsType: 'details',
        resultsLimit: 1,
        addParentData: false,
      },
      callOptions,
    );
  } catch (err) {
    log.error({ err }, 'Apify actor call failed');
    throw new InstagramScraperError('unknown', `Apify call failed: ${(err as Error).message}`);
  }

  if (run.status !== 'SUCCEEDED') {
    log.error({ runStatus: run.status }, 'Apify actor did not succeed');
    throw new InstagramScraperError('unknown', `Apify run finished with status ${run.status}`);
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 1 });
  return parseScraperItems(items as RawApifyItem[], handle, options.postsLimit ?? 12);
}

// ----- internal types + parser -----

type RawApifyPost = {
  id?: string;
  type?: string;
  shortCode?: string;
  url?: string;
  caption?: string;
  displayUrl?: string;
  images?: string[];
  likesCount?: number;
  commentsCount?: number;
  timestamp?: string;
  isPinned?: boolean;
  alt?: string;
  mentions?: string[];
};

export type RawApifyItem = {
  username?: string;
  url?: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  profilePicUrl?: string;
  profilePicUrlHD?: string;
  verified?: boolean;
  isBusinessAccount?: boolean;
  private?: boolean;
  externalUrl?: string;
  latestPosts?: RawApifyPost[];
  /** Apify returns `error: 'not_found_or_blocked'` etc. for failed lookups. */
  error?: string;
};

/**
 * Maps the raw Apify dataset items into our normalized shape. Exported so
 * tests can drive it directly with captured fixtures.
 */
export function parseScraperItems(
  items: RawApifyItem[],
  handle: string,
  postsLimit: number,
): InstagramScrapeResult {
  if (!items || items.length === 0) {
    throw new InstagramScraperError('not_found', `No data returned for @${handle}`);
  }
  const item = items[0]!;
  if (item.error) {
    const code = item.error.includes('private') ? 'private' : 'not_found';
    throw new InstagramScraperError(code, `Apify reported: ${item.error}`);
  }
  if (item.private) {
    throw new InstagramScraperError(
      'private',
      `@${handle} is a private account; we can't analyze it without access.`,
    );
  }

  const profile: InstagramProfile = {
    username: item.username ?? handle,
    url: item.url ?? `https://www.instagram.com/${handle}`,
    ...(item.fullName !== undefined ? { fullName: item.fullName } : {}),
    ...(item.biography !== undefined ? { biography: item.biography } : {}),
    ...(item.followersCount !== undefined ? { followersCount: item.followersCount } : {}),
    ...(item.followsCount !== undefined ? { followsCount: item.followsCount } : {}),
    ...(item.postsCount !== undefined ? { postsCount: item.postsCount } : {}),
    ...(item.profilePicUrl !== undefined ? { profilePicUrl: item.profilePicUrl } : {}),
    ...(item.profilePicUrlHD !== undefined ? { profilePicUrlHD: item.profilePicUrlHD } : {}),
    ...(item.verified !== undefined ? { isVerified: item.verified } : {}),
    ...(item.isBusinessAccount !== undefined ? { isBusinessAccount: item.isBusinessAccount } : {}),
    ...(item.externalUrl !== undefined ? { externalUrl: item.externalUrl } : {}),
  };

  const rawPosts = (item.latestPosts ?? []).slice(0, postsLimit);
  const posts: InstagramPost[] = rawPosts
    .filter((p) => Boolean(p.displayUrl) && Boolean(p.url) && Boolean(p.id))
    .map((p) => ({
      id: p.id!,
      type: p.type ?? 'Image',
      shortCode: p.shortCode ?? '',
      url: p.url!,
      caption: p.caption ?? '',
      imageUrl: p.displayUrl!,
      images: p.images && p.images.length > 0 ? p.images : [p.displayUrl!],
      ...(p.likesCount !== undefined ? { likesCount: p.likesCount } : {}),
      ...(p.commentsCount !== undefined ? { commentsCount: p.commentsCount } : {}),
      ...(p.timestamp !== undefined ? { timestamp: p.timestamp } : {}),
      ...(p.isPinned !== undefined ? { isPinned: p.isPinned } : {}),
      ...(p.alt !== undefined ? { alt: p.alt } : {}),
      ...(p.mentions !== undefined ? { mentions: p.mentions } : {}),
    }));

  if (posts.length === 0) {
    throw new InstagramScraperError(
      'empty',
      `@${handle} has no recent posts we can analyze.`,
    );
  }

  return { profile, posts };
}
