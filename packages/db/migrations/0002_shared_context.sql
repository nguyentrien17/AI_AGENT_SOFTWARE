CREATE TYPE "public"."handoff_status" AS ENUM('completed', 'partial', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('decision', 'fact', 'constraint', 'lesson');--> statement-breakpoint
CREATE TYPE "public"."package_item_source" AS ENUM('explicit', 'handoff', 'default');--> statement-breakpoint
CREATE TYPE "public"."relevance" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"from_agent" text NOT NULL,
	"to_agent" text NOT NULL,
	"status" "handoff_status" NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"artifact_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"workflow_run_id" uuid,
	"label" text NOT NULL,
	"context_version" integer NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"git_commit" text,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_package_items" (
	"package_id" uuid NOT NULL,
	"context_version_id" uuid NOT NULL,
	"context_item_id" uuid NOT NULL,
	"relevance" "relevance" NOT NULL,
	"source" "package_item_source" NOT NULL,
	CONSTRAINT "context_package_items_package_id_context_version_id_pk" PRIMARY KEY("package_id","context_version_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_role" text NOT NULL,
	"cache_key" text NOT NULL,
	"context_version" integer NOT NULL,
	"estimated_tokens" integer NOT NULL,
	"token_budget" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model_config_version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"content" text NOT NULL,
	"source_ref" text,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "context_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_artifact_item_id_context_items_id_fk" FOREIGN KEY ("artifact_item_id") REFERENCES "public"."context_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_package_items" ADD CONSTRAINT "context_package_items_package_id_context_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."context_packages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_package_items" ADD CONSTRAINT "context_package_items_context_version_id_context_versions_id_fk" FOREIGN KEY ("context_version_id") REFERENCES "public"."context_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_package_items" ADD CONSTRAINT "context_package_items_context_item_id_context_items_id_fk" FOREIGN KEY ("context_item_id") REFERENCES "public"."context_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_packages" ADD CONSTRAINT "context_packages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_packages" ADD CONSTRAINT "context_packages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_handoffs_task_idx" ON "agent_handoffs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_handoffs_project_idx" ON "agent_handoffs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkpoints_project_idx" ON "checkpoints" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_package_items_item_idx" ON "context_package_items" USING btree ("context_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_packages_valid_cache_key_uq" ON "context_packages" USING btree ("cache_key") WHERE "context_packages"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_packages_task_idx" ON "context_packages" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_memories_project_idx" ON "project_memories" USING btree ("project_id","kind");