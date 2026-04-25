CREATE TYPE "public"."brand_status" AS ENUM('pending', 'onboarding', 'active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('draft', 'pending_approval', 'approved', 'delivered', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_status" AS ENUM('running', 'suspended', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wa_phone" text NOT NULL,
	"ig_handle" text,
	"voice_json" jsonb DEFAULT 'null'::jsonb,
	"cadence_json" jsonb DEFAULT 'null'::jsonb,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" "brand_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"wa_thread_id" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"caption" text NOT NULL,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"edit_notes" jsonb DEFAULT 'null'::jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"draft_id" uuid,
	"run_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"suspended_step" text,
	"suspend_payload" jsonb DEFAULT 'null'::jsonb,
	"status" "workflow_run_status" DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_drafts" ADD CONSTRAINT "post_drafts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_draft_id_post_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."post_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_wa_phone_idx" ON "brands" USING btree ("wa_phone");--> statement-breakpoint
CREATE INDEX "conversations_brand_idx" ON "conversations" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "post_drafts_brand_idx" ON "post_drafts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "post_drafts_status_idx" ON "post_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "post_drafts_scheduled_idx" ON "post_drafts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_run_id_idx" ON "workflow_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_brand_status_idx" ON "workflow_runs" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "workflow_runs_draft_idx" ON "workflow_runs" USING btree ("draft_id");