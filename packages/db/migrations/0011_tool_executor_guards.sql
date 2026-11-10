-- Every tool call is evidence (Blueprint §11.2, §17): the log is append-only.
CREATE TRIGGER tool_executions_append_only BEFORE UPDATE OR DELETE ON tool_executions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
