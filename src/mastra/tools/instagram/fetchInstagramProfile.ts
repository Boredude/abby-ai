import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  fetchInstagramProfile,
  InstagramScraperError,
} from '../../../services/apify/instagramScraper.js';

const profileSchema = z.object({
  username: z.string(),
  url: z.string(),
  fullName: z.string().optional(),
  biography: z.string().optional(),
  followersCount: z.number().optional(),
  followsCount: z.number().optional(),
  postsCount: z.number().optional(),
  profilePicUrl: z.string().optional(),
  profilePicUrlHD: z.string().optional(),
  isVerified: z.boolean().optional(),
  isBusinessAccount: z.boolean().optional(),
  externalUrl: z.string().optional(),
});

const postSchema = z.object({
  id: z.string(),
  type: z.string(),
  shortCode: z.string(),
  url: z.string(),
  caption: z.string(),
  imageUrl: z.string(),
  images: z.array(z.string()),
  likesCount: z.number().optional(),
  commentsCount: z.number().optional(),
  timestamp: z.string().optional(),
  isPinned: z.boolean().optional(),
  alt: z.string().optional(),
  mentions: z.array(z.string()).optional(),
});

export const fetchInstagramProfileTool = createTool({
  id: 'fetchInstagramProfile',
  description:
    "Fetches an Instagram profile and its most recent posts via Apify's instagram-scraper. Always call this before running any visual or voice analysis. Returns the profile metadata plus a list of recent posts with image URLs and captions. Throws a typed error if the account is private, missing, or has no posts.",
  inputSchema: z.object({
    handle: z
      .string()
      .min(1)
      .describe("The brand's Instagram handle, with or without a leading '@'."),
    postsLimit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('How many recent posts to keep (default 12).'),
  }),
  outputSchema: z.object({
    profile: profileSchema,
    posts: z.array(postSchema),
  }),
  execute: async (inputData) => {
    try {
      const result = await fetchInstagramProfile(inputData.handle, {
        ...(inputData.postsLimit ? { postsLimit: inputData.postsLimit } : {}),
      });
      return result;
    } catch (err) {
      if (err instanceof InstagramScraperError) {
        throw new Error(`Instagram scrape failed (${err.code}): ${err.message}`);
      }
      throw err;
    }
  },
});
