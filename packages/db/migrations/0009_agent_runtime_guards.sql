-- Immutability / append-only guards for Phase 5 (Blueprint §6.1 immutable agent versions, §9.3 executions).
CREATE TRIGGER agent_versions_append_only BEFORE UPDATE OR DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER workflow_versions_append_only BEFORE UPDATE OR DELETE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_executions_append_only BEFORE UPDATE OR DELETE ON agent_executions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER task_assignments_append_only BEFORE UPDATE OR DELETE ON task_assignments
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
-- A task execution is written once when claimed and closed exactly once: only the outcome columns may
-- change, and only while the execution is still running.
CREATE OR REPLACE FUNCTION platform_task_execution_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.allow_purge', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'task_executions rows cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'task execution % is closed and immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'task execution identity columns are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER task_executions_guard BEFORE UPDATE OR DELETE ON task_executions
  FOR EACH ROW EXECUTE FUNCTION platform_task_execution_guard();
--> statement-breakpoint
-- An approval decision is final.
CREATE OR REPLACE FUNCTION platform_approval_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.allow_purge', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'approvals rows cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval % is already decided', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approvals_guard BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION platform_approval_guard();
