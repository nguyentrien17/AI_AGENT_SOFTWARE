CREATE TYPE "public"."adapter_type" AS ENUM('openai_compatible', 'gemini', 'anthropic');--> statement-breakpoint
CREATE TYPE "public"."capability_support" AS ENUM('yes', 'no', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."config_scope" AS ENUM('global', 'project', 'workflow', 'agent', 'task');--> statement-breakpoint
CREATE TYPE "public"."invocation_purpose" AS ENUM('agent', 'playground', 'probe');--> statement-breakpoint
CREATE TYPE "public"."invocation_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."model_availability" AS ENUM('available', 'unavailable', 'unknown', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."model_capability" AS ENUM('tool_calling', 'structured_output', 'vision', 'streaming', 'reasoning', 'prompt_caching', 'embeddings');--> statement-breakpoint
CREATE TYPE "public"."model_source" AS ENUM('manual', 'synced');--> statement-breakpoint
CREATE TYPE "public"."probe_result" AS ENUM('connection_successful', 'authentication_failed', 'model_unavailable', 'rate_limited', 'timeout', 'unsupported_capability', 'unknown_error');--> statement-breakpoint
CREATE TYPE "public"."provider_health" AS ENUM('unknown', 'healthy', 'degraded', 'failing');--> statement-breakpoint
CREATE TYPE "public"."quality_tier" AS ENUM('economy', 'standard', 'high', 'frontier', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."routing_mode" AS ENUM('fixed', 'adaptive', 'hybrid');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_model_allowlist" (
	"config_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	CONSTRAINT "agent_model_allowlist_config_id_model_id_pk" PRIMARY KEY("config_id","model_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_model_config_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"config_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by_type" text NOT NULL,
	"changed_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_model_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" "config_scope" NOT NULL,
	"scope_ref_id" uuid,
	"agent_key" text,
	"scope_key" text NOT NULL,
	"mode" "routing_mode" NOT NULL,
	"primary_model_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"routing_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_model_fallbacks" (
	"config_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"model_id" uuid NOT NULL,
	CONSTRAINT "agent_model_fallbacks_config_id_position_pk" PRIMARY KEY("config_id","position")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_connection_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" uuid,
	"result" "probe_result" NOT NULL,
	"latency_ms" integer,
	"http_status" integer,
	"diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_model_capabilities" (
	"model_id" uuid NOT NULL,
	"capability" "model_capability" NOT NULL,
	"support" "capability_support" DEFAULT 'unknown' NOT NULL,
	"verified_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_capabilities_model_id_capability_pk" PRIMARY KEY("model_id","capability")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_model_pricing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_id" uuid NOT NULL,
	"input_per_mtok" numeric(14, 6) NOT NULL,
	"output_per_mtok" numeric(14, 6) NOT NULL,
	"cached_input_per_mtok" numeric(14, 6),
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_key" text NOT NULL,
	"display_name" text NOT NULL,
	"availability" "model_availability" DEFAULT 'unknown' NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"quality_tier" "quality_tier" DEFAULT 'unknown' NOT NULL,
	"metadata_verified" boolean DEFAULT false NOT NULL,
	"source" "model_source" DEFAULT 'manual' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"key_version" integer NOT NULL,
	"masked_hint" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"display_name" text NOT NULL,
	"adapter_type" "adapter_type" NOT NULL,
	"base_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" "provider_health" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_records" (
	"invocation_id" uuid PRIMARY KEY NOT NULL,
	"estimated_cost" numeric(14, 6),
	"actual_cost" numeric(14, 6),
	"currency" text,
	"pricing_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose" "invocation_purpose" NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"agent_key" text,
	"agent_version" integer,
	"project_id" uuid,
	"workflow_id" uuid,
	"task_id" uuid,
	"config_id" uuid,
	"config_version" integer,
	"provider_request_id" text,
	"status" "invocation_status" NOT NULL,
	"error_kind" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"routing_explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_routing_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hard_ceilings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playground_benchmarks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"run_ids" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playground_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invocation_id" uuid,
	"comparison_id" uuid,
	"model_id" uuid NOT NULL,
	"simulated_role" text,
	"system_prompt" text DEFAULT '' NOT NULL,
	"user_prompt" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_usage" (
	"invocation_id" uuid PRIMARY KEY NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_allowlist" ADD CONSTRAINT "agent_model_allowlist_config_id_agent_model_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."agent_model_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_allowlist" ADD CONSTRAINT "agent_model_allowlist_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_config_history" ADD CONSTRAINT "agent_model_config_history_config_id_agent_model_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."agent_model_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_configs" ADD CONSTRAINT "agent_model_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_configs" ADD CONSTRAINT "agent_model_configs_primary_model_id_ai_models_id_fk" FOREIGN KEY ("primary_model_id") REFERENCES "public"."ai_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_fallbacks" ADD CONSTRAINT "agent_model_fallbacks_config_id_agent_model_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."agent_model_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_model_fallbacks" ADD CONSTRAINT "agent_model_fallbacks_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_connection_tests" ADD CONSTRAINT "ai_connection_tests_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_connection_tests" ADD CONSTRAINT "ai_connection_tests_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_model_capabilities" ADD CONSTRAINT "ai_model_capabilities_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_model_pricing" ADD CONSTRAINT "ai_model_pricing_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_provider_credentials" ADD CONSTRAINT "ai_provider_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_invocation_id_model_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."model_invocations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_pricing_id_ai_model_pricing_id_fk" FOREIGN KEY ("pricing_id") REFERENCES "public"."ai_model_pricing"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_routing_policies" ADD CONSTRAINT "model_routing_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "playground_benchmarks" ADD CONSTRAINT "playground_benchmarks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "playground_benchmarks" ADD CONSTRAINT "playground_benchmarks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_invocation_id_model_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."model_invocations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "playground_runs" ADD CONSTRAINT "playground_runs_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_invocation_id_model_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."model_invocations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_model_config_history_uq" ON "agent_model_config_history" USING btree ("config_id","config_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_model_configs_scope_uq" ON "agent_model_configs" USING btree ("workspace_id","scope","scope_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_connection_tests_provider_idx" ON "ai_connection_tests" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_model_pricing_model_idx" ON "ai_model_pricing" USING btree ("model_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_models_provider_key_uq" ON "ai_models" USING btree ("provider_id","model_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_credentials_active_uq" ON "ai_provider_credentials" USING btree ("provider_id") WHERE "ai_provider_credentials"."active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_credentials_provider_idx" ON "ai_provider_credentials" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_ws_key_uq" ON "ai_providers" USING btree ("workspace_id","provider_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_invocations_ws_created_idx" ON "model_invocations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_invocations_task_idx" ON "model_invocations" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_invocations_project_idx" ON "model_invocations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playground_runs_ws_created_idx" ON "playground_runs" USING btree ("workspace_id","created_at");