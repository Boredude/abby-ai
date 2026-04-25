import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const apifyMocks = vi.hoisted(() => ({
  call: vi.fn(),
  listItems: vi.fn(),
  ApifyClientCtor: vi.fn(),
}));

vi.mock('apify-client', () => {
  apifyMocks.ApifyClientCtor.mockImplementation(() => ({
    actor: () => ({ call: apifyMocks.call }),
    dataset: () => ({ listItems: apifyMocks.listItems }),
  }));
  return { ApifyClient: apifyMocks.ApifyClientCtor };
});

import {
  fetchInstagramProfile,
  InstagramScraperError,
  normalizeIgHandle,
  parseScraperItems,
  type RawApifyItem,
} from '../../src/services/apify/instagramScraper.js';

const detailsFixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'instagramScraper.details.json'),
    'utf-8',
  ),
) as RawApifyItem[];

describe('normalizeIgHandle', () => {
  it.each([
    ['@humansofny', 'humansofny'],
    ['humansofny', 'humansofny'],
    ['humansofny/', 'humansofny'],
    ['  HumansOfNY  ', 'humansofny'],
    ['@@nike', 'nike'],
    ['ob.cocktails', 'ob.cocktails'],
    ['https://www.instagram.com/nike/', 'nike'],
    ['https://www.instagram.com/nike', 'nike'],
    ['https://instagram.com/nike?hl=en', 'nike'],
    ['http://m.instagram.com/nike/', 'nike'],
    ['instagram.com/nike', 'nike'],
    ['www.instagram.com/nike/', 'nike'],
    ['https://www.instagram.com/nike/p/CabcDEF/', 'nike'],
    ['https://www.instagram.com/nike/reel/Xyz/', 'nike'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizeIgHandle(input)).toBe(expected);
  });

  it('rejects empty or whitespace-y values', () => {
    expect(() => normalizeIgHandle('')).toThrow(InstagramScraperError);
    expect(() => normalizeIgHandle('   ')).toThrow(InstagramScraperError);
    expect(() => normalizeIgHandle('foo bar')).toThrow(InstagramScraperError);
  });

  it('rejects non-instagram URLs', () => {
    expect(() => normalizeIgHandle('https://twitter.com/nike')).toThrow(InstagramScraperError);
    expect(() => normalizeIgHandle('https://www.instagram.com/p/abc/')).toThrow(
      InstagramScraperError,
    );
  });
});

describe('parseScraperItems', () => {
  it('parses a real-shaped Apify response into normalized profile + posts', () => {
    const result = parseScraperItems(detailsFixture, 'humansofny', 12);

    expect(result.profile).toMatchObject({
      username: 'humansofny',
      fullName: 'Humans of New York',
      isVerified: true,
      followersCount: 12_717_661,
      externalUrl: 'https://bit.ly/4tX4uZt',
    });

    expect(result.posts.length).toBeGreaterThanOrEqual(3);
    const first = result.posts[0]!;
    expect(first.id).toBeTruthy();
    expect(first.url).toMatch(/instagram\.com\/p\//);
    expect(first.imageUrl).toBeTruthy();
    expect(Array.isArray(first.images)).toBe(true);
    expect(first.images.length).toBeGreaterThan(0);
    expect(typeof first.caption).toBe('string');
  });

  it('respects postsLimit', () => {
    const result = parseScraperItems(detailsFixture, 'humansofny', 2);
    expect(result.posts).toHaveLength(2);
  });

  it('throws not_found for an empty dataset', () => {
    expect(() => parseScraperItems([], 'nope', 12)).toThrow(InstagramScraperError);
  });

  it('throws private when the actor reports the account is private', () => {
    const item: RawApifyItem = { username: 'priv', private: true, latestPosts: [] };
    expect(() => parseScraperItems([item], 'priv', 12)).toThrowError(/private/i);
  });

  it('throws empty when there are no posts', () => {
    const item: RawApifyItem = { username: 'noposts', latestPosts: [] };
    try {
      parseScraperItems([item], 'noposts', 12);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InstagramScraperError);
      expect((err as InstagramScraperError).code).toBe('empty');
    }
  });

  it('falls back to displayUrl when images[] is missing', () => {
    const item: RawApifyItem = {
      username: 'simple',
      url: 'https://www.instagram.com/simple',
      latestPosts: [
        {
          id: '1',
          type: 'Image',
          shortCode: 'a',
          url: 'https://www.instagram.com/p/a/',
          displayUrl: 'https://example.com/a.jpg',
          caption: '',
        },
      ],
    };
    const result = parseScraperItems([item], 'simple', 12);
    expect(result.posts[0]!.images).toEqual(['https://example.com/a.jpg']);
    expect(result.posts[0]!.imageUrl).toBe('https://example.com/a.jpg');
  });
});

describe('fetchInstagramProfile (mocked client)', () => {
  beforeEach(() => {
    apifyMocks.call.mockReset();
    apifyMocks.listItems.mockReset();
  });

  it('calls the Apify actor and parses the result', async () => {
    apifyMocks.call.mockResolvedValue({
      status: 'SUCCEEDED',
      defaultDatasetId: 'mock-dataset',
    });
    apifyMocks.listItems.mockResolvedValue({ items: detailsFixture });

    const result = await fetchInstagramProfile('@HumansOfNY', { postsLimit: 5 });

    expect(apifyMocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        directUrls: ['https://www.instagram.com/humansofny/'],
        resultsType: 'details',
        resultsLimit: 1,
      }),
      expect.any(Object),
    );
    expect(result.profile.username).toBe('humansofny');
    expect(result.posts).toHaveLength(4);
  });

  it('throws InstagramScraperError when the run does not succeed', async () => {
    apifyMocks.call.mockResolvedValue({ status: 'FAILED' });
    await expect(fetchInstagramProfile('humansofny')).rejects.toBeInstanceOf(
      InstagramScraperError,
    );
  });
});
