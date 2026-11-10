-- Append-only / immutability guards (Blueprint §6.1, §7.7, §12.4, §17).
-- Purges are only possible inside an approved maintenance transaction that sets `app.allow_purge = 'on'`.
CREATE OR REPLACE FUNCTION platform_reject_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.allow_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER task_status_history_append_only BEFORE UPDATE OR DELETE ON task_status_history
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER quality_gate_evaluations_append_only BEFORE UPDATE OR DELETE ON quality_gate_evaluations
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform_context_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.allow_purge', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'context_versions rows cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.context_item_id IS DISTINCT FROM OLD.context_item_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.storage_uri IS DISTINCT FROM OLD.storage_uri
     OR NEW.author_type IS DISTINCT FROM OLD.author_type
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'context_versions content columns are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'approved artifact versions cannot return to draft' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER context_versions_guard BEFORE UPDATE OR DELETE ON context_versions
  FOR EACH ROW EXECUTE FUNCTION platform_context_version_guard();
