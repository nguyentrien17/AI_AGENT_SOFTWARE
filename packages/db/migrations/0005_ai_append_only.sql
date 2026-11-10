-- Append-only & immutability guards for Phase 3 AI Management tables (Blueprint §3.2, §4.5, §10.2).
CREATE TRIGGER ai_model_pricing_append_only BEFORE UPDATE OR DELETE ON ai_model_pricing
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_model_config_history_append_only BEFORE UPDATE OR DELETE ON agent_model_config_history
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_connection_tests_append_only BEFORE UPDATE OR DELETE ON ai_connection_tests
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER model_invocations_append_only BEFORE UPDATE OR DELETE ON model_invocations
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER token_usage_append_only BEFORE UPDATE OR DELETE ON token_usage
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER cost_records_append_only BEFORE UPDATE OR DELETE ON cost_records
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform_credential_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.allow_purge', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ai_provider_credentials rows cannot be deleted; revoke instead' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
     OR NEW.iv IS DISTINCT FROM OLD.iv
     OR NEW.auth_tag IS DISTINCT FROM OLD.auth_tag
     OR NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek
     OR NEW.key_version IS DISTINCT FROM OLD.key_version
     OR NEW.masked_hint IS DISTINCT FROM OLD.masked_hint
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ai_provider_credentials envelope columns are immutable; rotate to create a new credential' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.active = false AND NEW.active = true THEN
    RAISE EXCEPTION 'revoked credentials cannot be reactivated' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ai_provider_credentials_guard BEFORE UPDATE OR DELETE ON ai_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION platform_credential_guard();
