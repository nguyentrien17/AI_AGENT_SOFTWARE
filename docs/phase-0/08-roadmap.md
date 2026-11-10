# 08 — Implementation Roadmap (Phases → Atomic Tasks) & Phase Gates

Each task ends with: tests run + docs updated + post-task report (`docs/reports/<task-id>.md`, Blueprint §20.6).

## Phase 0 — Discovery & Foundation
| ID | Task |
|----|------|
| P0-01 | Requirements & domain model ✅ draft |
| P0-02 | ADRs ✅ draft |
| P0-03 | Architecture & components ✅ draft |
| P0-04 | ERD & schema spec ✅ draft |
| P0-05 | Repo structure ✅ draft |
| P0-06 | API map ✅ draft |
| P0-07 | Security model ✅ draft |
| P0-08 | Roadmap + gates ✅ draft |
| P0-09 | *(after approval)* git init, npm workspaces skeleton, tsconfig, ESLint/Prettier, Vitest, dependency-cruiser, CI workflow, README + setup script |

## Phase 1 — Core Platform Foundation
P1-01 `shared` (uuidv7, RFC7807 errors, redaction, result) · P1-02 `db` factory (PGlite/PG) + migration runner · P1-03 IAM schema + migrations · P1-04 auth (argon2id, sessions) · P1-05 RBAC policy engine + matrix tests · P1-06 workspaces/members API · P1-07 projects/members/settings API (+ project folder & git repo init) · P1-08 requirements/stories/AC API · P1-09 `storage` adapter (atomic write, sha256) · P1-10 artifact manager (versions, approval immutability) · P1-11 task state machine + tasks API + transitions · P1-12 audit logger + outbox table · P1-13 idempotency middleware · P1-14 web shell (login, nav, projects list/detail, tasks Kanban).

## Phase 2 — Shared Project Context Engine
P2-01 context registry (`.ai-context` tree scaffold, items/versions) · P2-02 write-permission enforcement by role · P2-03 optimistic concurrency · P2-04 handoff schema validator + API · P2-05 Context Package Builder (deps, permissions, dedupe, token estimate) · P2-06 package cache + composite key · P2-07 invalidation on `artifact.versioned` · P2-08 checkpoints · P2-09 integration test: Agent A → package → Agent B → mutate → invalidated · P2-10 Context Explorer UI.

## Phase 3 — AI Management
P3-01 SecretStore (AES-256-GCM envelope) · P3-02 providers CRUD + credential rotate · P3-03 adapter interface + OpenAI-compatible adapter · P3-04 Gemini adapter · P3-05 Anthropic adapter · P3-06 probe service (7 result classes) · P3-07 model registry + capabilities + pricing (unknown handling) · P3-08 model sync · P3-09 agent model configs (scoped, versioned, allowlist, fallbacks) + capability validation · P3-10 Playground (isolated, budget cap, compare) · P3-11 UI: Providers, Models, Agent Assignment matrix, Config detail, Playground.

## Phase 4 — Model Router & Token Budget
P4-01 5-level precedence resolver · P4-02 policy/ceiling overlay · P4-03 hard filters · P4-04 scoring + explanation · P4-05 fixed/adaptive/hybrid engines · P4-06 fallback FSM · P4-07 invocation ledger (usage, estimated/actual cost) · P4-08 budget hierarchy + thresholds + halt/checkpoint · P4-09 usage/cost analytics API · P4-10 Usage & Costs UI.

## Phase 5 — Agent Runtime & Orchestration
P5-01 agent registry + immutable versions + YAML seeding · P5-02 execution runtime (prompt assembly, schema-validated outputs) · P5-03 workflow definitions/versions · P5-04 workflow engine (conditional, parallel, gates) · P5-05 DAG + cycle detection + promotion · P5-06 scheduler + leases/heartbeats + recovery · P5-07 bounded retries/backoff/escalation · P5-08 pause/resume/cancel · P5-09 approvals manager · P5-10 SSE event stream · P5-11 e2e multi-step workflow test (with labeled test adapter) · P5-12 Workflow/Agent dashboards.

## Phase 6 — Tool Executor & Sandbox *(requires Docker)*
P6-01 tool registry · P6-02 permission guard (7 dims) · P6-03 path jail · P6-04 fs tools · P6-05 git tools (worktrees, branches `task/{id}`, diff, guards) · P6-06 Docker SandboxAdapter + limits · P6-07 runtime images (node, python, php, java, dotnet) · P6-08 terminal/test-runner tools · P6-09 log streaming · P6-10 escape tests.

## Phase 7 — Specialized Agents
P7-01..06 BA, Architect, Database, Developer, QA, Review definitions + schemas + prompts · P7-07 default SDLC workflow + adaptive variants · P7-08 integration/merge stage · P7-09 bounded repair loop · P7-10 sample app end-to-end.

## Phase 8 — Quality Gates, Hardening, Approvals
P8-01 gate engine + evidence · P8-02 secret scanner · P8-03 dependency vuln scanner · P8-04 migration up/down validation · P8-05 approval UI · P8-06 lineage API/UI · P8-07 concurrency & lease recovery tests · P8-08 full regression suite.

## Phase 9 — Post-MVP
Extended agents/skills, optional vector search, cross-project knowledge, scaling, cloud deploy, plugins.

---
## Phase Gates
| Phase | Verification (automated unless stated) |
|-------|----------------------------------------|
| 0 | Human approves ADRs, MVP scope & open decisions (09) |
| 1 | Integration tests: register→login→create project→members/RBAC denies→task transitions (invalid rejected)→artifact versioning (approved immutable)→restart process & data persists; CI green |
| 2 | Tests prove deterministic package (same inputs ⇒ same cache key), hash verification fails on tamper, permission denial, invalidation on new version, consumption without transcripts |
| 3 | Credential never present in API responses/logs (asserted); probe classifies all 7 classes (adapter contract tests with HTTP fixtures); reassigning an agent's model via API changes the provider called at runtime without code change |
| 4 | Precedence matrix tests; allowlist violation blocked; each fallback trigger & prohibited scenario; budget thresholds incl. halt + checkpoint; every invocation has routing explanation in audit |
| 5 | E2E workflow of ≥3 agents with handoffs; kill worker mid-task ⇒ lease expiry ⇒ recovery; pause/resume; retries bounded |
| 6 | Sample Node + Python project built/tested in sandbox; escape tests (path traversal, network, host fs, secrets env) all blocked |
| 7 | From a prompt, platform produces runnable sample app with passing tests and review report |
| 8 | Task cannot reach `completed` with any failing mandatory check; all high-risk ops block until human approval; regression suite green |
| MVP | All 7 pillars of Blueprint §19 verified |
