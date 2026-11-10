-- Append-only guards for Phase 2 tables (Blueprint §6.4 handoffs, §7.1 checkpoints).
CREATE TRIGGER agent_handoffs_append_only BEFORE UPDATE OR DELETE ON agent_handoffs
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER checkpoints_append_only BEFORE UPDATE OR DELETE ON checkpoints
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER context_package_items_append_only BEFORE UPDATE OR DELETE ON context_package_items
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
