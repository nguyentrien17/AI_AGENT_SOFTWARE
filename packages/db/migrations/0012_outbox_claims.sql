ALTER TABLE "system_events" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "system_events" ADD COLUMN "claimed_until" timestamp with time zone;