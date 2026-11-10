CREATE TYPE "public"."budget_level" AS ENUM('system', 'project', 'workflow', 'task', 'invocation');--> statement-breakpoint
CREATE TYPE "public"."budget_threshold_band" AS ENUM('normal', 'optimize_50', 'warning_70', 'restrict_85', 'halt_95', 'exhausted_100');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"budget_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"previous_band" "budget_threshold_band" NOT NULL,
	"new_band" "budget_threshold_band" NOT NULL,
	"utilization_pct" numeric(7, 2) NOT NULL,
	"consumed_tokens" bigint NOT NULL,
	"consumed_cost_usd" numeric(14, 6) NOT NULL,
	"action_taken" text NOT NULL,
	"checkpoint_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fallback_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invocation_id" uuid,
	"agent_key" text NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"original_model_id" uuid NOT NULL,
	"fallback_model_id" uuid,
	"attempt_count" integer NOT NULL,
	"trigger_kind" text NOT NULL,
	"allowed" boolean NOT NULL,
	"halt_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"level" "budget_level" NOT NULL,
	"scope_ref_id" uuid,
	"scope_key" text NOT NULL,
	"token_limit" bigint,
	"cost_limit_usd" numeric(14, 6),
	"currency" text DEFAULT 'USD' NOT NULL,
	"consumed_tokens" bigint DEFAULT 0 NOT NULL,
	"consumed_cost_usd" numeric(14, 6) DEFAULT '0.000000' NOT NULL,
	"current_band" "budget_threshold_band" DEFAULT 'normal' NOT NULL,
	"halted" boolean DEFAULT false NOT NULL,
	"last_checkpoint_id" uuid,
	"thresholds" jsonb DEFAULT '{"optimizePct":50,"warningPct":70,"restrictPct":85,"haltPct":95}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_events" ADD CONSTRAINT "budget_events_budget_id_token_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."token_budgets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_events" ADD CONSTRAINT "budget_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fallback_events" ADD CONSTRAINT "fallback_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fallback_events" ADD CONSTRAINT "fallback_events_original_model_id_ai_models_id_fk" FOREIGN KEY ("original_model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fallback_events" ADD CONSTRAINT "fallback_events_fallback_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_budgets" ADD CONSTRAINT "token_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_events_budget_idx" ON "budget_events" USING btree ("budget_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fallback_events_ws_created_idx" ON "fallback_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "token_budgets_ws_level_scope_uq" ON "token_budgets" USING btree ("workspace_id","level","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_routing_policies_ws_name_uq" ON "model_routing_policies" USING btree ("workspace_id","name");