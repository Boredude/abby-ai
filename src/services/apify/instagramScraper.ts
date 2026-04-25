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
 * Strip the leading `@` and any trailing slash, lowercase the result.
 * Throws if the handle is empty or contains whitespace.
 */
export function normalizeIgHandle(input: string): string {
  const trimmed = input.trim().replace(/^@/, '').replace(/\/$/, '').toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new InstagramScraperError('not_found', `Invalid Instagram handle: "${input}"`);
  }
  return trimmed;
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
