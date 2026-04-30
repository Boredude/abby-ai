import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the network + R2 boundaries before we import the SUT so the
// module-level imports pick up the stubs. We keep the real `pickOwnerSegment`
// / `sanitizeOwnerSlug` helpers — they're pure and the tests assert against
// the slugified key paths they produce.
vi.mock('../../src/services/onboarding/visionImage.js', () => ({
  downloadImage: vi.fn(),
}));
vi.mock('../../src/services/storage/r2.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    uploadToR2: vi.fn(),
  };
});

import { downloadImage } from '../../src/services/onboarding/visionImage.js';
import { uploadToR2 } from '../../src/services/storage/r2.js';
import {
  mirrorIgImage,
  mirrorIgImages,
} from '../../src/services/onboarding/igImageMirror.js';

const mockedDownload = downloadImage as unknown as ReturnType<typeof vi.fn>;
const mockedUpload = uploadToR2 as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.resetAllMocks();
});

describe('mirrorIgImage', () => {
  it('uploads bytes under a content-addressed R2 key keyed by the source URL', async () => {
    mockedDownload.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg',
    });
    mockedUpload.mockImplementation(async ({ key }: { key: string }) => ({
      key,
      url: `https://r2.example/${key}`,
    }));

    const a = await mirrorIgImage(
      { brandId: 'brand-1' },
      { label: 'profile-pic', url: 'https://ig.example/x' },
    );
    const b = await mirrorIgImage(
      { brandId: 'brand-1' },
      { label: 'profile-pic', url: 'https://ig.example/x' },
    );

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Same source URL → same R2 key (idempotent across retries).
    expect(a!.key).toBe(b!.key);
    expect(a!.key).toMatch(/^ig-mirror\/brand-1\/profile-pic-[0-9a-f]{16}\.jpg$/);
    expect(a!.originalUrl).toBe('https://ig.example/x');
    expect(a!.url).toBe(`https://r2.example/${a!.key}`);
    expect(a!.mediaType).toBe('image/jpeg');
  });

  it('uses the IG handle as the owner segment when provided, sanitized', async () => {
    mockedDownload.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg',
    });
    mockedUpload.mockImplementation(async ({ key }: { key: string }) => ({
      key,
      url: `https://r2.example/${key}`,
    }));

    // Mixed-case + leading "@" should normalize down to a clean segment.
    const r = await mirrorIgImage(
      { brandId: 'brand-1', igHandle: '@CocktailsHQ' },
      { label: 'profile-pic', url: 'https://ig.example/x' },
    );
    expect(r!.key).toMatch(/^ig-mirror\/cocktailshq\/profile-pic-[0-9a-f]{16}\.jpg$/);
  });

  it('falls back to brandId when no IG handle is available', async () => {
    mockedDownload.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg',
    });
    mockedUpload.mockImplementation(async ({ key }: { key: string }) => ({
      key,
      url: `https://r2.example/${key}`,
    }));

    const r = await mirrorIgImage(
      { brandId: 'brand-1', igHandle: null },
      { label: 'profile-pic', url: 'https://ig.example/x' },
    );
    expect(r!.key).toMatch(/^ig-mirror\/brand-1\/profile-pic-/);
  });

  it('returns null when the source download fails', async () => {
    mockedDownload.mockRejectedValue(new Error('IG 403'));
    const r = await mirrorIgImage(
      { brandId: 'brand-1' },
      { label: 'profile-pic', url: 'https://ig.example/x' },
    );
    expect(r).toBeNull();
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it('returns null when the R2 upload fails (download succeeded)', async () => {
    mockedDownload.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg',
    });
    mockedUpload.mockRejectedValue(new Error('R2 down'));
    const r = await mirrorIgImage(
      { brandId: 'brand-1' },
      { label: 'profile-pic', url: 'https://ig.example/x' },
    );
    expect(r).toBeNull();
  });

  it('uses the right extension for png/webp/gif sources', async () => {
    const cases: Array<{ ct: string; ext: string }> = [
      { ct: 'image/png', ext: 'png' },
      { ct: 'image/webp', ext: 'webp' },
      { ct: 'image/gif', ext: 'gif' },
    ];
    for (const { ct, ext } of cases) {
      mockedDownload.mockResolvedValueOnce({ bytes: new Uint8Array([0]), mediaType: ct });
      mockedUpload.mockImplementationOnce(async ({ key }: { key: string }) => ({
        key,
        url: `https://r2.example/${key}`,
      }));
      const r = await mirrorIgImage(
        { brandId: 'brand-1' },
        { label: 'profile-pic', url: `https://ig.example/${ext}` },
      );
      expect(r?.key.endsWith(`.${ext}`)).toBe(true);
    }
  });
});

describe('mirrorIgImages', () => {
  it('returns a map keyed by original URL, omitting failed entries', async () => {
    mockedDownload.mockImplementation(async (url: string) => {
      if (url.includes('fail')) throw new Error('boom');
      return { bytes: new Uint8Array([0]), mediaType: 'image/jpeg' };
    });
    mockedUpload.mockImplementation(async ({ key }: { key: string }) => ({
      key,
      url: `https://r2.example/${key}`,
    }));

    const map = await mirrorIgImages({ brandId: 'brand-1' }, [
      { label: 'profile-pic', url: 'https://ig.example/p' },
      { label: 'post-1', url: 'https://ig.example/fail' },
      { label: 'post-2', url: 'https://ig.example/q' },
    ]);
    expect([...map.keys()].sort()).toEqual([
      'https://ig.example/p',
      'https://ig.example/q',
    ]);
    expect(map.get('https://ig.example/p')?.url).toMatch(/^https:\/\/r2\.example\/ig-mirror\/brand-1\/profile-pic-/);
  });

  it('returns an empty map for an empty input list without calling the network', async () => {
    const map = await mirrorIgImages({ brandId: 'brand-1' }, []);
    expect(map.size).toBe(0);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(mockedUpload).not.toHaveBeenCalled();
  });
});
