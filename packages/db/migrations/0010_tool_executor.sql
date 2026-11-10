CREATE TYPE "public"."tool_execution_status" AS ENUM('succeeded', 'failed', 'denied', 'approval_required', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."tool_permission_subject" AS ENUM('agent_version', 'role');--> statement-breakpoint
CREATE TYPE "public"."tool_risk" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_execution_id" uuid,
	"tool_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" "tool_execution_status" NOT NULL,
	"decision" jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"exit_code" integer,
	"duration_ms" integer NOT NULL,
	"sandbox_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" "tool_permission_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"tool_key" text NOT NULL,
	"file_scopes" text[] DEFAULT '{}' NOT NULL,
	"max_risk" "tool_risk" DEFAULT 'medium' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_registry" (
	"tool_key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"action" text NOT NULL,
	"required_scopes" text[] DEFAULT '{}' NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"risk" "tool_risk" NOT NULL,
	"idempotent" boolean NOT NULL,
	"requires_sandbox" boolean DEFAULT false NOT NULL,
	"redaction_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtimes" text[] DEFAULT '{}' NOT NULL,
	"definition_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_permissions" ADD CONSTRAINT "tool_permissions_tool_key_tool_registry_tool_key_fk" FOREIGN KEY ("tool_key") REFERENCES "public"."tool_registry"("tool_key") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_executions_task_idx" ON "tool_executions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_permissions_subject_tool_uq" ON "tool_permissions" USING btree ("workspace_id","subject_type","subject_id","tool_key");