ALTER TABLE "brands" ADD COLUMN "brand_kit_json" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "design_system_json" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "ig_analysis_json" jsonb DEFAULT 'null'::jsonb;