import * as cheerio from 'cheerio';
import { logger } from '../../config/logger.js';

/**
 * Lightweight website analyzer used to enrich brand typography. We fetch the
 * brand's homepage HTML, pull out font-family declarations from inline styles
 * and linked stylesheets (including Google Fonts), and surface a structured
 * snapshot the synthesizer can attach to the brand kit. The whole thing is
 * best-effort: any failure (timeout, non-2xx, parse error, etc.) returns an
 * `ok: false` result so the orchestrator can drop the analyzer cleanly.
 *
 * No headless browser — only HTML + CSS parsing. Dynamic / SPA-only pages may
 * yield no fonts, which is acceptable: typography from the post grid still
 * acts as the fallback.
 */

const FETCH_TIMEOUT_MS = 8_000;
const STYLESHEET_TIMEOUT_MS = 3_000;
const HTML_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const CSS_MAX_BYTES = 256 * 1024; // 256 KB
const MAX_STYLESHEETS = 5;
const MAX_FONT_FAMILIES = 12;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Limit to true CSS keywords + generic-family names + emoji/system fallbacks.
// We DON'T filter out names like "Roboto", "Arial", "Helvetica Neue" — many
// brands actually pick those deliberately and we want to surface them. The
// loaded-fonts ground truth (Google Fonts + @font-face) already does the
// disambiguation between "intentional pick" and "system fallback".
const GENERIC_FONT_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  '-apple-system',
  'blinkmacsystemfont',
  'apple color emoji',
  'segoe ui emoji',
  'segoe ui symbol',
  'noto color emoji',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

export type WebsiteAnalysis = {
  ok: true;
  sourceUrl: string;
  resolvedUrl: string;
  fontFamilies: string[];
  headingFont?: string;
  bodyFont?: string;
  googleFonts: string[];
  pageTitle?: string;
};

export type WebsiteAnalysisFailure = {
  ok: false;
  sourceUrl: string;
  reason:
    | 'invalid_url'
    | 'http_error'
    | 'timeout'
    | 'too_large'
    | 'parse_error'
    | 'unknown';
  message: string;
};

export type WebsiteAnalysisResult = WebsiteAnalysis | WebsiteAnalysisFailure;

export type AnalyzeWebsiteInput = {
  handle: string;
  websiteUrl: string;
  brandHint?: string;
};

/**
 * Add an `https://` scheme if the user (or scraper) only sent us a bare
 * domain. We tolerate trailing slashes, paths, and query strings.
 */
export function normalizeWebsiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname.length === 0 || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchWithLimits(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; accept: string },
): Promise<{ body: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.accept,
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} fetching ${url}`, res.status);
    }
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength && contentLength > opts.maxBytes) {
      throw new TooLargeError(`Response too large (${contentLength} bytes) for ${url}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > opts.maxBytes) {
      throw new TooLargeError(`Response too large (${buf.byteLength} bytes) for ${url}`);
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { body, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

function parseFontFamilyValue(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter((part) => part.length > 0);
}

function isUsableFontName(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (lower.length === 0 || lower.length > 60) return false;
  if (lower.startsWith('var(') || lower.startsWith('--')) return false;
  if (GENERIC_FONT_KEYWORDS.has(lower)) return false;
  return true;
}

function dedupeKeepFirst(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// IMPORTANT: these regex literals are constructed fresh on each call.
// Module-level /g RegExp instances share `lastIndex` across invocations,
// and any `break` in an `.exec` loop leaves the state dirty for the next
// call (a bug we hit when tests started exercising the analyzer multiple
// times in one process).

function collectFontFamiliesFromCss(css: string): string[] {
  const re = /font-family\s*:\s*([^;{}]+)/gi;
  const families: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const value = match[1];
    if (!value) continue;
    for (const name of parseFontFamilyValue(value)) {
      if (isUsableFontName(name)) families.push(name);
    }
  }
  return families;
}

/**
 * Pull every font-family declared inside an `@font-face` block. Sites only
 * write @font-face for fonts they actually load (self-hosted, Adobe/Typekit,
 * Cloudflare/Vercel font assets, etc.), so this set is ground truth for "the
 * brand spent bandwidth on this font" — same level of trust as the Google
 * Fonts links.
 */
function collectFontFaceFamilies(css: string): string[] {
  const re = /@font-face\s*\{([^{}]*)\}/gi;
  const families: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const block = match[1] ?? '';
    const declMatch = /font-family\s*:\s*([^;{}]+)/i.exec(block);
    if (!declMatch) continue;
    for (const name of parseFontFamilyValue(declMatch[1] ?? '')) {
      if (isUsableFontName(name)) families.push(name);
    }
  }
  return families;
}

function inSet(name: string, set: Set<string>): boolean {
  return set.has(name.toLowerCase());
}

/**
 * Walk every selector block and capture the heading vs. body font. When we
 * have a `loadedFonts` ground-truth set we trust it: pick the first font in
 * the declaration that appears in `loadedFonts` (skipping system fallbacks
 * like Lucida Console / Helvetica that show up first in a fallback chain
 * even though the brand never actually loaded them).
 *
 * When `loadedFonts` is empty (e.g. site uses purely system fonts) we fall
 * back to the previous "first font wins" behavior.
 */
function pickHeadingAndBodyFonts(
  css: string,
  loadedFonts: Set<string>,
): { heading?: string; body?: string } {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let heading: string | undefined;
  let body: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const selector = (match[1] ?? '').toLowerCase();
    const block = match[2] ?? '';
    const declMatch = /font-family\s*:\s*([^;{}]+)/i.exec(block);
    if (!declMatch) continue;
    const families = parseFontFamilyValue(declMatch[1] ?? '').filter(isUsableFontName);
    if (families.length === 0) continue;
    const trusted = loadedFonts.size > 0 ? families.find((f) => inSet(f, loadedFonts)) : undefined;
    const candidate = trusted ?? (loadedFonts.size === 0 ? families[0] : undefined);
    if (!candidate) continue;
    const isHeading = /(^|[\s,>+~])h[1-3](\b|[.:#\s,]|$)/.test(selector);
    const isBody = /(^|[\s,>+~])body(\b|[.:#\s,]|$)/.test(selector) ||
      /(^|[\s,>+~])p(\b|[.:#\s,]|$)/.test(selector);
    if (isHeading && !heading) heading = candidate;
    if (isBody && !body) body = candidate;
    if (heading && body) break;
  }
  return { heading, body };
}

function extractGoogleFontFamilies(href: string): string[] {
  try {
    const url = new URL(href);
    if (!url.hostname.endsWith('fonts.googleapis.com')) return [];
    const families: string[] = [];
    // Both /css and /css2 endpoints accept `family=`; css2 may have multiple.
    for (const value of url.searchParams.getAll('family')) {
      const name = value.split(':')[0]?.replace(/\+/g, ' ').trim();
      if (name && isUsableFontName(name)) families.push(name);
    }
    return families;
  } catch {
    return [];
  }
}

function classifyFetchError(err: unknown): WebsiteAnalysisFailure['reason'] {
  if (err instanceof TooLargeError) return 'too_large';
  if (err instanceof HttpError) return 'http_error';
  const e = err as { name?: string; message?: string };
  if (e?.name === 'AbortError') return 'timeout';
  return 'unknown';
}

export async function analyzeWebsite(
  input: AnalyzeWebsiteInput,
): Promise<WebsiteAnalysisResult> {
  const log = logger.child({ analyzer: 'website', handle: input.handle });
  const normalized = normalizeWebsiteUrl(input.websiteUrl);
  if (!normalized) {
    return {
      ok: false,
      sourceUrl: input.websiteUrl,
      reason: 'invalid_url',
      message: `Could not parse website URL: ${input.websiteUrl}`,
    };
  }

  let html: string;
  let resolvedUrl: string;
  try {
    const result = await fetchWithLimits(normalized, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: HTML_MAX_BYTES,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    });
    html = result.body;
    resolvedUrl = result.finalUrl;
  } catch (err) {
    const reason = classifyFetchError(err);
    log.warn({ err, url: normalized, reason }, 'Failed to fetch website HTML');
    return {
      ok: false,
      sourceUrl: input.websiteUrl,
      reason,
      message: (err as Error).message,
    };
  }

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    log.warn({ err, url: resolvedUrl }, 'Failed to parse website HTML');
    return {
      ok: false,
      sourceUrl: input.websiteUrl,
      reason: 'parse_error',
      message: (err as Error).message,
    };
  }

  const pageTitle = $('title').first().text().trim() || undefined;

  const inlineStyles: string[] = [];
  $('style').each((_, el) => {
    const text = $(el).text();
    if (text) inlineStyles.push(text);
  });

  $('[style]').each((_, el) => {
    const styleAttr = $(el).attr('style');
    if (styleAttr && styleAttr.includes('font-family')) {
      inlineStyles.push(`__inline__ { ${styleAttr} }`);
    }
  });

  const stylesheetUrls: string[] = [];
  const googleFonts: string[] = [];
  $('link[rel~="stylesheet"][href], link[rel="preload"][as="style"][href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let absolute: string;
    try {
      absolute = new URL(href, resolvedUrl).toString();
    } catch {
      return;
    }
    googleFonts.push(...extractGoogleFontFamilies(absolute));
    if (stylesheetUrls.length < MAX_STYLESHEETS) {
      stylesheetUrls.push(absolute);
    }
  });

  // Some sites declare the family on a `<link rel="preload" as="font">` with
  // a literal family name in the URL; we ignore those — the regex pass over
  // CSS captures the actual `font-family:` rules.

  const externalCss: string[] = [];
  await Promise.all(
    stylesheetUrls.map(async (url) => {
      try {
        const { body } = await fetchWithLimits(url, {
          timeoutMs: STYLESHEET_TIMEOUT_MS,
          maxBytes: CSS_MAX_BYTES,
          accept: 'text/css,*/*;q=0.5',
        });
        externalCss.push(body);
      } catch (err) {
        log.debug({ err, url }, 'Failed to fetch stylesheet; skipping');
      }
    }),
  );

  const allCss = [...inlineStyles, ...externalCss].join('\n');

  // "Loaded" fonts = fonts the site actually pays the bandwidth to ship.
  // This is ground truth for "the brand cares about this font" and is much
  // more reliable than the first item in any given font-family fallback
  // chain (which is often a system font like "Lucida Console" or
  // "Helvetica" used as a stylistic fallback).
  const familiesFromGoogle = dedupeKeepFirst(googleFonts.filter(isUsableFontName));
  const familiesFromFontFace = dedupeKeepFirst(collectFontFaceFamilies(allCss));
  const loadedFontsList = dedupeKeepFirst([...familiesFromGoogle, ...familiesFromFontFace]);
  const loadedFontsSet = new Set(loadedFontsList.map((f) => f.toLowerCase()));

  const familiesFromCss = collectFontFamiliesFromCss(allCss);
  // Surface loaded fonts first so downstream consumers that fall back to
  // `fontFamilies[0]` get the brand's actual choice rather than a fallback.
  const fontFamilies = dedupeKeepFirst([...loadedFontsList, ...familiesFromCss]).slice(
    0,
    MAX_FONT_FAMILIES,
  );

  let { heading, body } = pickHeadingAndBodyFonts(allCss, loadedFontsSet);
  // If the selector heuristic couldn't anchor to anything in the loaded set
  // (e.g. site has @font-face but no h1/body rule we recognized), back-fill
  // from the loaded fonts so the kit still gets real font names.
  if (loadedFontsList.length > 0) {
    if (!heading) heading = loadedFontsList[0];
    if (!body) {
      body = loadedFontsList.find((f) => !heading || f.toLowerCase() !== heading.toLowerCase())
        ?? loadedFontsList[0];
    }
  }

  log.info(
    {
      url: resolvedUrl,
      stylesheets: stylesheetUrls.length,
      fontCount: fontFamilies.length,
      loadedFontCount: loadedFontsList.length,
      hasHeadingFont: Boolean(heading),
      hasBodyFont: Boolean(body),
    },
    'Website analysis succeeded',
  );

  return {
    ok: true,
    sourceUrl: input.websiteUrl,
    resolvedUrl,
    fontFamilies,
    googleFonts: familiesFromGoogle,
    ...(heading ? { headingFont: heading } : {}),
    ...(body ? { bodyFont: body } : {}),
    ...(pageTitle ? { pageTitle } : {}),
  };
}
