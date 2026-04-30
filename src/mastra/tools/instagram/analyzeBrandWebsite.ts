import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeWebsite } from '../../../services/onboarding/analyzeWebsite.js';

const websiteAnalysisSuccess = z.object({
  ok: z.literal(true),
  sourceUrl: z.string(),
  resolvedUrl: z.string(),
  fontFamilies: z.array(z.string()),
  headingFont: z.string().optional(),
  bodyFont: z.string().optional(),
  googleFonts: z.array(z.string()),
  pageTitle: z.string().optional(),
});

const websiteAnalysisFailure = z.object({
  ok: z.literal(false),
  sourceUrl: z.string(),
  reason: z.enum([
    'invalid_url',
    'http_error',
    'timeout',
    'too_large',
    'parse_error',
    'unknown',
  ]),
  message: z.string(),
});

export const analyzeBrandWebsiteTool = createTool({
  id: 'analyzeBrandWebsite',
  description:
    "Fetches the brand's website homepage HTML and stylesheets, extracts the actual font families used (heading vs body when distinguishable), and detects Google Fonts. Use this when a website URL is available — either from the IG profile's externalUrl or supplied by the user. Best-effort: returns ok=false on fetch/parse failure so the kit can still be built without it.",
  inputSchema: z.object({
    handle: z.string(),
    websiteUrl: z
      .string()
      .min(3)
      .describe(
        'Website URL to analyze. May be a bare domain (example.com) or fully-qualified URL.',
      ),
    brandHint: z.string().optional().describe('Optional extra context from the user.'),
  }),
  outputSchema: z.union([websiteAnalysisSuccess, websiteAnalysisFailure]),
  execute: async (inputData) => {
    return analyzeWebsite({
      handle: inputData.handle,
      websiteUrl: inputData.websiteUrl,
      ...(inputData.brandHint ? { brandHint: inputData.brandHint } : {}),
    });
  },
});
