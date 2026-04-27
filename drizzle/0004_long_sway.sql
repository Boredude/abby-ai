CREATE TABLE "ig_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_state_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
