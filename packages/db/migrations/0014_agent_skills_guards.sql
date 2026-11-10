-- Skills are immutable per version (Blueprint §6.1/§6.3).
CREATE TRIGGER agent_skills_append_only BEFORE UPDATE OR DELETE ON agent_skills
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
