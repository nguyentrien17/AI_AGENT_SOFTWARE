-- Append-only guards for Phase 4 ledgers (Blueprint §5.4 fallback log, §10.4 budget threshold log).
CREATE TRIGGER budget_events_append_only BEFORE UPDATE OR DELETE ON budget_events
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER fallback_events_append_only BEFORE UPDATE OR DELETE ON fallback_events
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
