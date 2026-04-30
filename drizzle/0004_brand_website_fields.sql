ALTER TABLE "brands" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "awaiting_website_reply" boolean DEFAULT false NOT NULL;