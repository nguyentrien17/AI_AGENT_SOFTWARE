# Phase 5 — Agent Runtime & Core Orchestration — Post-Task Reports

Format per Blueprint §20.6. Date: 2026-11-10. Token/cost usage: not reported by the environment.

---
## P5-00 — Schema & migrations
- **Created:** `packages/db/src/schema/agents.ts` (`agents`, `agent_versions`, `agent_executions`), `schema/workflows.ts` (`workflows`, `workflow_versions`, `workflow_runs`, `workflow_steps`, `task_assignments`, `task_executions`, `task_leases`, `approvals`); migrations `0008_agent_runtime.sql`, `0009_agent_runtime_guards.sql`.
- **Modified:** `schema/tasks.ts` (`not_before` — retry backoff), `schema/index.ts`.
- **Guards:** `agent_versions`, `workflow_versions`, `agent_executions`, `task_assignments` append-only; a `task_executions` row can only be closed once and its identity columns never change; an approval decision is final.

## P5-01 — Agent registry (`packages/agent-runtime`)
- **Created:** `src/registry.ts`, `src/seed.ts`, `agent-library/{ba,architect,database,review}.yaml`, `agent-library/README.md`.
- Every definition change creates a new immutable version (content-hashed); re-publishing an identical definition is a no-op, so seeding is idempotent. Definitions never name a model. `role` must be a context-access role. Output-repair retries are capped at 3.

## P5-02 — Execution runtime
- **Created:** `src/runtime.ts` (`executeAgentTask`), `src/output.ts` (output envelope + Ajv validation).
- Flow: build Context Package → load + hash-verify → trusted system instruction (agent definition + platform contract) and **untrusted** context in a separate message → `routeAndInvoke` (Phase 4 router, never an adapter directly) → validate envelope → bounded repair re-prompt on violations → persist artifacts as the agent actor (role write areas enforced) → submit hashed handoff → `agent_executions` row.
- `needs_input` returns open questions instead of guessing. The runtime never changes task status.

## P5-03/04 — Workflows & engine (`packages/orchestration/src/workflows.ts`)
- Immutable definition versions, cycle and reference validation before any run.
- Conditional branching (`when` with equals / notEquals / in / exists / all / any / not); skipped stages are rewired out of the dependency graph. Parallelism comes from the task DAG. `approval: 'human'` inserts an approval gate.
- Runs: start (agents resolved up front), pause, resume, cancel; run status derived from step status.

## P5-05 — DAG
Existing Phase 1 DAG (cycle detection, promotion, cancellation blocking) reused; workflow tasks are wired into it.

## P5-06/07/08 — Scheduler (`src/scheduler.ts`)
- `claimNextTask`: oldest `ready` task past its backoff, in a running (not paused) run; creates `task_executions` + `task_leases` (unique per task = no duplicate execution) + `task_assignments`.
- `heartbeat`, `recoverExpiredLeases` (execution `abandoned`, task back to `ready` or `failed` when retries are exhausted), `LeaseLostError` discards a stale worker's result.
- Failures: retryable → `failed → ready` with exponential backoff + full jitter; exhausted → `failed` + `task.retries_exhausted`; budget blocked → run paused, no retry consumed; routing/invocation halt → `waiting_for_input`. Retries escalate complexity so a hybrid config may upgrade the model.
- Completion only through gate evidence: `agent_output_contract` (+ `human_approval` for gated stages).
- `runWorkerOnce` / `drainWorker`; in-process worker `apps/api/src/worker.ts` (env `WORKER_ENABLED`, `WORKER_IDLE_MS`).

## P5-09 — Approvals (`src/approvals.ts`)
Only a human with `artifact.approve` decides; agents and system components are rejected. Rejection needs a comment, sends the task back for rework within its bounded retries, and the comment reaches the agent as feedback.

## P5-10 — Events
`listProjectEvents` over the outbox (UUIDv7 cursor); `GET /projects/{id}/events` and SSE `GET /projects/{id}/events/stream` (resumes from `Last-Event-ID`; `follow=false` returns the backlog and closes).

## API
`GET|POST /agents` · `POST /agents/seed` · `GET /agents/{id}` · `GET|POST /agents/{id}/versions` · `PUT /agents/{id}/status` · `GET|POST /workflows` · `GET /workflows/{id}` · `POST /workflows/{id}/versions` · `GET|POST /projects/{id}/workflow-runs` · `GET /workflow-runs/{id}` · `POST /workflow-runs/{id}/pause|resume|cancel` · `GET /tasks/{id}/executions` · `GET /projects/{id}/approvals` · `POST /approvals/{id}/decision` · `GET /projects/{id}/events` · `GET /projects/{id}/events/stream`.
Files: `apps/api/src/routes/workflows.ts`, `apps/api/src/worker.ts`, `apps/api/src/budget-halt.ts` (shared halt → checkpoint handler), `config.ts`, `main.ts`, `.env.example`.

## Bugs found in earlier phases and fixed
| Phase | Bug | Fix |
|-------|-----|-----|
| 2 | Context Package cache key had no task or project id: two tasks with the same title/objective — even in different projects — shared one package (cross-project context leak). | `taskSpecHash` now includes `projectId` and `taskId`; regression test in `packages/context/test/unit.test.ts`. |
| 3 | All three adapters threw a provider error when the model's text was not JSON for a requested `jsonSchema`. Tokens already billed were never recorded and the router wrongly treated it as a provider failure (fallback). | Adapters return `structuredOutput: null` with the text; callers validate (the agent runtime repairs within its bound). |

## Tests executed
`npm run verify` — typecheck, ESLint, dependency-cruiser (no violations, 137 modules), Vitest: **21 files, 198 tests passed** (178 after Phase 4, +20).
New: `packages/orchestration/test/workflow.test.ts` (13), `packages/agent-runtime/test/output.test.ts` (4), `apps/api/test/workflows.e2e.test.ts` (2), cache-key regression (1).

## Open issues & risks
| # | Item | Plan |
|---|------|------|
| R16 | Provider change that "requires approval" still only blocks; no approval request is raised for it | Phase 8 approval UI/API can raise `kind: provider_change` |
| R19 | Pre-dispatch token estimate is `chars / 4` | Unchanged |
| R21 | `agent_skills`, `agent_tool_permissions` tables not created | Phase 6 tool registry / permission guard |
| R22 | Developer and QA agents not in the library (they need tools + sandbox) | Phase 6/7 |
| R23 | Worker runs inside the API process; no separate `apps/worker` | Add when scaling (Phase 9) — leases already make multiple workers safe |
| R24 | SSE polls the outbox every second; no push/notify | Acceptable for MVP; PostgreSQL `LISTEN/NOTIFY` later |
| R25 | Repair/feedback loops resend the full context each time (token cost) | Prompt caching where providers support it |
| R13/R15 | No web UI yet (P1-14, P2-10, P3-11, P4-10, P5-12) | Web UI sprint — ADR-010 still needs approval |

## Phase 5 Gate
**Passed** — `packages/orchestration/test/workflow.test.ts`:
- **E2E workflow of ≥3 agents with handoffs:** BA → Architect (human approval gate, one rejection with feedback, then approval) → Database ‖ API design in parallel → Review; run completes; six hashed handoffs; the architect received the BA's artifact only through the Context Package, as untrusted data, with no transcript.
- **Kill worker mid-task ⇒ lease expiry ⇒ recovery:** worker A claims and dies; nobody else can claim while the lease is valid; heartbeats extend it; after expiry the execution is `abandoned`, the task returns to `ready`, worker B completes it, and A's late result is rejected with `LeaseLostError`.
- **Pause/resume:** nothing is scheduled while paused; resume continues; cancel stops open tasks and steps; a budget halt pauses the run without consuming retries and resumes after a human raises the limit.
- **Retries bounded:** 3 attempts (1 + `maxRetries` 2), each with at most one output repair, backoff 5 s then 10 s, then `failed` with full failure context and `task.retries_exhausted`; nothing more happens however long the worker runs.
