# 06 — REST API Domain & Endpoint Map

Standards: `/api/v1` prefix · TypeBox-validated DTOs → OpenAPI 3.1 at `/api/v1/openapi.json` · RFC 7807 errors · cursor pagination (`?cursor&limit≤100`) · `Idempotency-Key` on mutating POST/PUT · session-cookie auth + RBAC middleware · rate limit per user · audit on sensitive actions (★). Phase column = when implemented.

| Domain | Endpoints | Phase |
|--------|-----------|-------|
| auth | `POST /auth/register` (first user = owner) · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` | 1 |
| users | `GET /users` · `GET/PUT /users/{id}` | 1 |
| workspaces | `GET/POST /workspaces` · `GET/PUT /workspaces/{id}` · `GET/POST/DELETE /workspaces/{id}/members`★ | 1 |
| projects | `GET/POST /projects` · `GET/PUT/DELETE /projects/{id}`★(delete needs approval) · `GET/POST/DELETE /projects/{id}/members` · `GET/PUT /projects/{id}/settings` | 1 |
| requirements | `GET/POST /projects/{id}/requirements` · `GET/PUT /requirements/{id}` · `.../user-stories` · `.../acceptance-criteria` | 1 |
| architecture | `GET/POST /projects/{id}/architecture/documents` · `.../decisions` · `.../database-designs` · `.../api-contracts` | 7 |
| artifacts | `GET /projects/{id}/artifacts` · `GET /artifacts/{id}/versions` · `GET /artifacts/{id}/versions/{n}/content` · `POST /artifacts/{id}/versions` | 1 |
| context | `GET /projects/{id}/context` · `GET /projects/{id}/context/{context_id}` · `POST /projects/{id}/context/packages` · `GET /tasks/{id}/context` · `GET/POST /projects/{id}/memories` | 2 |
| agent-handoffs | `POST /agents/{agent_id}/handoffs` · `GET /agent-handoffs?task_id=` · `GET /agent-handoffs/{id}` | 2 |
| tasks | `GET/POST /projects/{id}/tasks` · `GET/PUT /tasks/{id}` · `POST /tasks/{id}/transitions` · `GET/POST/DELETE /tasks/{id}/dependencies` · `GET /tasks/{id}/executions` | 1 / 5 |
| ai/providers | `GET/POST /ai/providers`★ · `GET/PUT/DELETE /ai/providers/{id}`★ · `POST /ai/providers/{id}/test` · `PUT /ai/providers/{id}/credentials`★ (rotate) · `POST /ai/providers/{id}/sync-models` | 3 |
| ai/models | `GET/POST /ai/models` · `GET/PUT/DELETE /ai/models/{id}` · `POST /ai/models/{id}/test` · `PUT /ai/models/{id}/pricing` | 3 |
| ai/configurations | `GET/POST /ai/configurations` (filter by scope/agent) · `GET/PUT/DELETE /ai/configurations/{id}` · `POST /ai/configurations/resolve` (dry-run router) · `GET/POST/PUT /ai/routing-policies`★ | 3 / 4 |
| ai/playground | `POST /ai/playground/runs` · `POST /ai/playground/compare` · `GET /ai/playground/runs` · `POST /ai/playground/benchmarks` | 3 |
| ai/usage, ai/costs | `GET /ai/usage` · `GET /ai/costs` (filters: provider, model, agent, project, workflow, task, from, to, group_by) · `GET/PUT /budgets` | 4 |
| agents | `GET/POST /agents` · `GET /agents/{id}` · `POST /agents/{id}/versions` · `GET /agents/{id}/versions` · `PUT /agents/{id}/status` | 5 |
| agent-executions | `GET /agent-executions` · `GET /agent-executions/{id}` (full trace) | 5 |
| workflows | `GET/POST /workflows` · `POST /workflows/{id}/versions` · `POST /projects/{id}/workflow-runs` · `GET /workflow-runs/{id}` · `POST /workflow-runs/{id}/pause` · `.../resume` · `.../cancel` | 5 |
| tools | `GET /tools` · `GET /tools/{key}` · `GET /tool-executions?task_id=` | 6 |
| sandboxes | `GET /sandboxes` · `GET /sandboxes/{id}` · `GET /sandboxes/{id}/logs` (SSE) · `POST /sandboxes/{id}/terminate` | 6 |
| tests | `GET /projects/{id}/test-runs` · `GET /test-runs/{id}` | 6 / 8 |
| reviews | `GET /projects/{id}/reviews` · `GET /reviews/{id}` · `GET/PUT /issues/{id}` | 7 |
| approvals | `GET /approvals?status=pending` · `GET /approvals/{id}` · `POST /approvals/{id}/decisions`★ (human only) | 5 / 8 |
| audit-logs | `GET /audit-logs` (filters) · `GET /lineage/agent-executions/{id}` (answers 8 lineage questions) | 1 / 8 |
| events | `GET /events/stream` (SSE, scoped by RBAC) | 5 |
