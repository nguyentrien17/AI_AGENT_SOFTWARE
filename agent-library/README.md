# Agent Library

Versioned agent definitions (Blueprint §6.1), one YAML file per agent. They are registered in a workspace
with `seedAgentLibrary` (`@platform/agent-runtime`) or `POST /api/v1/agents/seed`.

- A definition never names a provider or model: the Model Router resolves that from configuration.
- Editing a file and re-seeding publishes a **new immutable version**; existing versions are never rewritten.
- `role` must be one of the context-access roles in `packages/artifacts/src/access-policy.ts`. It decides
  which `.ai-context/` areas the agent may write.
- Every agent replies with the platform output envelope; `output_schema` describes its `result` field.

Phase 5 ships the agents that work purely on context artifacts (BA, Architect, Database, Review).
Developer and QA agents need the Tool Executor and sandbox and are added in Phase 6/7.
