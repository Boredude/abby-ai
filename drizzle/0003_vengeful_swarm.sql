CREATE TYPE "public"."brand_channel_status" AS ENUM('connected', 'pending', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('whatsapp', 'sms', 'telegram', 'instagram', 'tiktok');--> statement-breakpoint
CREATE TABLE "brand_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"external_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" "brand_channel_status" DEFAULT 'connected' NOT NULL,
	"metadata" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "brands_wa_phone_idx";--> statement-breakpoint
ALTER TABLE "brand_channels" ADD CONSTRAINT "brand_channels_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_channels_kind_external_idx" ON "brand_channels" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "brand_channels_brand_kind_idx" ON "brand_channels" USING btree ("brand_id","kind");--> statement-breakpoint
ALTER TABLE "brands" DROP COLUMN "wa_phone";