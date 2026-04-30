import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeWebsite,
  normalizeWebsiteUrl,
} from '../../src/services/onboarding/analyzeWebsite.js';

/**
 * The website analyzer is best-effort by design: any fetch / parse failure
 * should yield `{ ok: false }` so the orchestrator can drop it cleanly.
 * These tests stub `globalThis.fetch` so the parser can be exercised entirely
 * offline.
 */

type StubFetch = (url: string, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: StubFetch) {
  vi.stubGlobal('fetch', handler as unknown as typeof fetch);
}

function htmlResponse(body: string, opts: { url?: string; status?: number } = {}): Response {
  const res = new Response(body, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  // The cheerio loader looks at res.url to resolve relative <link href>.
  if (opts.url) {
    Object.defineProperty(res, 'url', { value: opts.url });
  }
  return res;
}

function cssResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/css; charset=utf-8' },
  });
}

describe('normalizeWebsiteUrl', () => {
  it('adds https:// when missing and validates the host', () => {
    expect(normalizeWebsiteUrl('example.com')).toBe('https://example.com/');
    expect(normalizeWebsiteUrl('  example.com/about  ')).toBe('https://example.com/about');
    expect(normalizeWebsiteUrl('http://example.com')).toBe('http://example.com/');
  });

  it('rejects strings without a dot or empty input', () => {
    expect(normalizeWebsiteUrl('')).toBeNull();
    expect(normalizeWebsiteUrl('not-a-url')).toBeNull();
  });
});

describe('analyzeWebsite', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('extracts heading + body fonts from inline styles and a stylesheet', async () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Acme</title>
          <link rel="stylesheet" href="/static/site.css">
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+Pro:wght@400;700&family=Inter&display=swap">
          <style>
            body { font-family: "Inter", sans-serif; }
            h1, h2 { font-family: "Source Serif Pro", Georgia, serif; }
          </style>
        </head>
        <body><h1>hi</h1></body>
      </html>
    `;
    const css = `
      .legal { font-family: 'Helvetica Neue', Arial, sans-serif; }
      h3 { font-family: "Source Serif Pro", serif; }
    `;

    stubFetch(async (url) => {
      if (url.includes('/static/site.css')) return cssResponse(css);
      return htmlResponse(html, { url: 'https://acme.example/' });
    });

    const result = await analyzeWebsite({
      handle: 'acme',
      websiteUrl: 'acme.example',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolvedUrl).toBe('https://acme.example/');
    expect(result.headingFont).toBe('Source Serif Pro');
    expect(result.bodyFont).toBe('Inter');
    expect(result.fontFamilies).toContain('Source Serif Pro');
    expect(result.fontFamilies).toContain('Inter');
    expect(result.fontFamilies).toContain('Helvetica Neue');
    expect(result.googleFonts).toContain('Source Serif Pro');
    expect(result.googleFonts).toContain('Inter');
    expect(result.pageTitle).toBe('Acme');
  });

  it('returns ok:false on HTTP failure without throwing', async () => {
    stubFetch(async () => new Response('nope', { status: 503 }));
    const result = await analyzeWebsite({ handle: 'acme', websiteUrl: 'acme.example' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('http_error');
  });

  it('returns ok:false for unparseable URLs', async () => {
    const result = await analyzeWebsite({ handle: 'acme', websiteUrl: 'not-a-domain' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_url');
  });
});
