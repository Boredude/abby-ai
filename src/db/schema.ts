import {
  pgTable,
  pgEnum,
  text,
  uuid,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Brand status during onboarding.
 *  - pending:   brand record created (we saw a phone), no profile yet
 *  - onboarding: in the middle of the onboarding workflow
 *  - active:    onboarded; receiving drafts
 *  - paused:    temporarily disabled by owner
 */
export const brandStatusEnum = pgEnum('brand_status', ['pending', 'onboarding', 'active', 'paused']);

/**
 * Lifecycle of a single post draft.
 */
export const draftStatusEnum = pgEnum('draft_status', [
  'draft',
  'pending_approval',
  'approved',
  'delivered',
  'rejected',
]);

export const workflowRunStatusEnum = pgEnum('workflow_run_status', [
  'running',
  'suspended',
  'completed',
  'failed',
]);

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    waPhone: text('wa_phone').notNull(),
    igHandle: text('ig_handle'),
    voiceJson: jsonb('voice_json').$type<BrandVoice | null>().default(null),
    cadenceJson: jsonb('cadence_json').$type<BrandCadence | null>().default(null),
    brandKitJson: jsonb('brand_kit_json').$type<BrandKit | null>().default(null),
    designSystemJson: jsonb('design_system_json').$type<BrandDesignSystem | null>().default(null),
    igAnalysisJson: jsonb('ig_analysis_json').$type<IgAnalysisSnapshot | null>().default(null),
    brandBoardImageUrl: text('brand_board_image_url'),
    timezone: text('timezone').default('UTC').notNull(),
    status: brandStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    waPhoneIdx: uniqueIndex('brands_wa_phone_idx').on(t.waPhone),
  }),
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    waThreadId: text('wa_thread_id'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    brandIdx: index('conversations_brand_idx').on(t.brandId),
  }),
);

export const postDrafts = pgTable(
  'post_drafts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    mediaUrls: jsonb('media_urls').$type<string[]>().default([]).notNull(),
    suggestedAt: timestamp('suggested_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: draftStatusEnum('status').default('draft').notNull(),
    editNotes: jsonb('edit_notes').$type<EditNote[] | null>().default(null),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    brandIdx: index('post_drafts_brand_idx').on(t.brandId),
    statusIdx: index('post_drafts_status_idx').on(t.status),
    scheduledIdx: index('post_drafts_scheduled_idx').on(t.scheduledAt),
  }),
);

/**
 * Maps a (brand + draft) tuple to the Mastra workflow run that is suspended
 * waiting for a WhatsApp reply, so the inbound webhook can resolve the run
 * to call `run.resume(...)`.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id').references(() => postDrafts.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    suspendedStep: text('suspended_step'),
    suspendPayload: jsonb('suspend_payload').$type<Record<string, unknown> | null>().default(null),
    status: workflowRunStatusEnum('status').default('running').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdIdx: uniqueIndex('workflow_runs_run_id_idx').on(t.runId),
    brandStatusIdx: index('workflow_runs_brand_status_idx').on(t.brandId, t.status),
    draftIdx: index('workflow_runs_draft_idx').on(t.draftId),
  }),
);

/**
 * Webhook idempotency dedupe table — keyed by Kapso's `X-Idempotency-Key`.
 * Inserts use `ON CONFLICT DO NOTHING` semantics in code.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    source: text('source').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

// ---- JSON shapes ----

export type BrandVoice = {
  summary: string;
  tone: string[];
  audience: string;
  do: string[];
  dont: string[];
  hashtags?: string[];
  themes?: string[];
  emojiUsage?: 'none' | 'sparing' | 'frequent';
  hashtagPolicy?: string;
};

export type BrandCadence = {
  postsPerWeek: number;
  preferredHourLocal?: number;
  daysOfWeek?: number[];
};

export type EditNote = {
  at: string;
  note: string;
};

export type BrandPaletteEntry = {
  hex: string;
  role: 'primary' | 'secondary' | 'accent' | 'background' | 'text' | 'other';
  name?: string;
};

export type BrandKit = {
  palette: BrandPaletteEntry[];
  typography: {
    mood: string;
    sample?: string;
  };
  logoNotes?: string;
};

export type BrandDesignSystem = {
  photoStyle: string;
  illustrationStyle: string;
  composition: string;
  lighting: string;
  recurringMotifs: string[];
  doVisuals: string[];
  dontVisuals: string[];
};

export type IgAnalysisSnapshot = {
  capturedAt: string;
  handle: string;
  profile: {
    fullName?: string;
    biography?: string;
    followers?: number;
    following?: number;
    postsCount?: number;
    profilePicUrl?: string;
    isVerified?: boolean;
    externalUrl?: string;
  };
  posts: Array<{
    url: string;
    imageUrl: string;
    caption: string;
    likes?: number;
    comments?: number;
    timestamp?: string;
    type?: 'image' | 'video' | 'sidecar' | 'reel';
  }>;
  rawVisuals?: unknown;
  rawVoice?: unknown;
};

// ---- Inferred row types ----

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
export type PostDraft = typeof postDrafts.$inferSelect;
export type NewPostDraft = typeof postDrafts.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
