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

  it('prefers loaded fonts (Google Fonts / @font-face) over system-font fallbacks', async () => {
    // Mirrors the ob.cocktails case: a heading rule names "Lucida Console"
    // first as a stylistic fallback, but the brand actually loads Lexend Deca
    // and Inter via Google Fonts. Ground truth = the loaded set.
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>OB</title>
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lexend+Deca&family=Inter&display=swap">
          <style>
            body { font-family: "Inter", sans-serif; }
            h1, h2 { font-family: "Lucida Console", "Courier New", "Lexend Deca", monospace; }
          </style>
        </head>
        <body><h1>hi</h1></body>
      </html>
    `;
    stubFetch(async () => htmlResponse(html, { url: 'https://obcocktails.example/' }));

    const result = await analyzeWebsite({ handle: 'ob', websiteUrl: 'obcocktails.example' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headingFont).toBe('Lexend Deca');
    expect(result.bodyFont).toBe('Inter');
    // Loaded fonts surface at the top of the families list.
    expect(result.fontFamilies.slice(0, 2)).toEqual(['Lexend Deca', 'Inter']);
  });

  it('treats @font-face declarations as ground truth (covers Adobe/self-hosted)', async () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>SelfHosted</title>
          <link rel="stylesheet" href="/site.css">
        </head>
        <body></body>
      </html>
    `;
    const css = `
      @font-face { font-family: "Calibre"; src: url('/fonts/calibre.woff2') format('woff2'); }
      @font-face { font-family: 'Tiempos'; src: url('/fonts/tiempos.woff2') format('woff2'); }
      body { font-family: "Helvetica Neue", "Calibre", sans-serif; }
      h1 { font-family: "Times New Roman", "Tiempos", serif; }
    `;
    stubFetch(async (url) => {
      if (url.includes('/site.css')) return cssResponse(css);
      return htmlResponse(html, { url: 'https://selfhost.example/' });
    });

    const result = await analyzeWebsite({ handle: 'sh', websiteUrl: 'selfhost.example' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headingFont).toBe('Tiempos');
    expect(result.bodyFont).toBe('Calibre');
    expect(result.fontFamilies).toEqual(
      expect.arrayContaining(['Calibre', 'Tiempos']),
    );
    // Calibre / Tiempos come before the system fallbacks in the list.
    expect(result.fontFamilies.indexOf('Calibre')).toBeLessThan(
      result.fontFamilies.indexOf('Helvetica Neue'),
    );
  });

  it('falls back to first-font-wins when no loaded fonts are present', async () => {
    // Pure system-font site: no Google Fonts link, no @font-face. We should
    // still pick something for the kit.
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>System</title>
          <style>
            body { font-family: Helvetica, Arial, sans-serif; }
            h1 { font-family: Georgia, serif; }
          </style>
        </head>
        <body></body>
      </html>
    `;
    stubFetch(async () => htmlResponse(html, { url: 'https://system.example/' }));

    const result = await analyzeWebsite({ handle: 'sys', websiteUrl: 'system.example' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headingFont).toBe('Georgia');
    expect(result.bodyFont).toBe('Helvetica');
  });
});
