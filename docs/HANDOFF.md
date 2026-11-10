# HANDOFF — Resume Point for Any AI Coding Agent

> **Read this file first.** It is the single resume point. You do NOT need to re-read the whole
> blueprint or codebase. Update this file every time a task is finished or a decision is made,
> *before* doing anything else, so work can be picked up by another agent at any moment.

Last updated: 2026-11-10 (Phases 0–5 done; Phase 6 part A done; part B blocked on Docker)

## 1. How to resume in 3 steps
1. Read section 2 (current task checklist) and section 3 (design decisions for the active phase).
2. Run `git status --short` and `npm run verify` to see the real state (typecheck + lint + depcheck + tests).
3. Continue with the first unchecked item in section 2. Tick it here when its tests pass.

Reference only when needed:
- Blueprint (source of truth): `ai_agent_software_platform_technical_blueprint (1).md`
  - Roadmap §18 (line ~2083), mandatory agent rules §20 (line ~2179)
- State ledger + package map: `docs/00-index/README.md`
- Atomic task list per phase + phase gates: `docs/phase-0/08-roadmap.md`
- Per-phase reports: `docs/reports/phase-N.md`

## 2. Current state & next step

**Phases 0–5 are complete and their gates passed. Phase 6 part A is done (gate still open).** Reports: `docs/reports/phase-1.md` … `phase-5.md`.
`npm run verify` = 25 test files / 250 tests green, typecheck + lint + dependency rules clean.
Phases 4–6A committed and pushed to `https://github.com/nguyentrien17/AI_AGENT_SOFTWARE` on 2026-11-10 (user request).

### Phase 6 — part A DONE (report `docs/reports/phase-6.md`); part B blocked. Next: ask the user — install a container runtime for part B, or start Phase 8 pieces / Web UI.
#### Part A (no Docker). User decided 2026-11-10: do everything that needs no container now; the Docker parts wait.
Gate stays **open** until part B (sandbox) is done. Blueprint: §11 (line 1589), §16.2 (line 2004), §16.4;
`docs/phase-0/07-security-model.md` §4–§6. Only `tool-executor` may use `child_process` (`.dependency-cruiser.cjs`).

- [x] A0 DB `schema/tools.ts`: `tool_registry`, `tool_permissions`, `tool_executions` (append-only); migrations 0010 + 0011 guards
- [x] A1 P6-01 Tool registry (code catalog, synced to `tool_registry`)
- [x] A2 P6-02 Permission guard, 7 dimensions (pure `evaluateToolPermission`)
- [x] A3 P6-03 Path jail (`jail.ts`; fails closed on dangling links) (realpath, traversal, absolute, symlink/junction, deny `.git/` and `.ai-context/`)
- [x] A4 P6-04 fs tools: `fs_read_file`, `fs_list_dir`, `fs_write_file`, `fs_delete_file`
- [x] A5 P6-05 git (`git.ts`, `process.ts`): task worktree + branch `task/{taskId}`, tools `git_status`, `git_diff`, `git_commit`, `git_log`, `git_check_merge`; destructive-op guard
- [x] A6 Executor `executeTool` (schema validation, guard, timeout, output caps, redaction, `tool_executions` row, audit)
- [x] A7 Agent runtime: bounded tool-call loop (agents with `allowed_tools`)
- [x] A8 API: `GET /tools`, `GET /tasks/{id}/tool-executions`, `GET /tasks/{id}/workspace/diff`
- [x] A9 Tests — tool-executor unit (39) + integration (7), adapter tool history (3), `apps/api/test/tools.e2e.test.ts` (3) incl. escape tests that do not need a container (path traversal, symlink, `.git`, destructive git)
- [x] A10 Docs: `docs/reports/phase-6.md` (part A), ledger, this file; `npm run verify` green

Part B (needs Docker or another container runtime — **not started, do not fake**): P6-06 Docker `SandboxAdapter`
+ limits, P6-07 runtime images, P6-08 terminal/test-runner tools, P6-09 log streaming, P6-10 container escape
tests, `sandbox_sessions` / `sandbox_artifacts` tables. ADR-009: no host-execution fallback; sandbox tools must
report `sandbox_unavailable`.

## 3. Design notes

### Phase 6 part A plan (decided 2026-11-10 — follow it, do not re-derive)
- New package `packages/tool-executor` (deps: db, iam, observability, shared, ajv). Files: `types.ts`,
  `glob.ts` (own matcher: `**`, `*`, `?`), `jail.ts`, `process.ts` (spawn with argv only, timeout,
  process-tree kill — `taskkill /T /F` on Windows, process group on POSIX, output caps), `git.ts`
  (`runGit` with destructive guard, worktrees, diff, merge-tree conflict check), `tools/fs.ts`,
  `tools/git.ts`, `catalog.ts`, `permissions.ts`, `executor.ts`.
- Task workspace = git worktree at `<storageRoot>/worktrees/<workspaceId>/<projectKey>/<taskId>` on branch
  `task/<taskId>`, created from the project's default branch on first tool use. Outside the project repo
  directory so worktrees never nest.
- fs tools can never touch `.git/**` (repo integrity) or `.ai-context/**` (versioned only via the Artifact
  Manager / agent output envelope).
- Permission guard order (deny by default): task bound + running + lease held → tool registered → tool in
  agent version `allowed_tools` (∩ task `allowed_tools` when non-empty) → tool action in agent
  `allowed_actions` → every path argument matches agent `allowed_file_scopes` (and per-tool
  `tool_permissions.file_scopes` if a row exists) → tool risk ≤ max risk (`tool_permissions.max_risk`,
  default `medium`) → risk `high`/`critical` ⇒ `require_approval` (executor refuses; no approval flow yet).
- Destructive git (force push, `reset --hard`, `branch -D`, `clean -f`, history rewrite, deleting protected
  branches) is refused inside `runGit` itself unless an approval id is passed — no agent tool exposes it.
- Agent runtime tool loop: tools offered only when the agent version has `allowed_tools` and the runtime is
  given a tool executor; max 25 tool calls per attempt; tool outputs go back as `tool` messages (untrusted).
- `agent_tool_permissions` from the Phase 0 ERD = the `tool_permissions` table (subject agent_version|role).

### Phase 5 (done) — design that later phases build on
**Packages**
- `packages/agent-runtime` (new; depends on `model-router`, `context`, `artifacts`):
  `registry.ts` (agents + immutable versions, content hash), `seed.ts` (loads `agent-library/*.yaml`),
  `output.ts` (output envelope + Ajv validation), `runtime.ts` (`executeAgentTask`).
- `packages/orchestration` (extend; may depend on `agent-runtime`, `budget`, `context`):
  `workflows.ts` (definitions, versions, runs, steps, engine), `scheduler.ts` (claim, lease, heartbeat,
  recovery, retries, worker tick), `approvals.ts`, `events.ts`.
- DB: `schema/agents.ts`, `schema/workflows.ts`, migrations `0008_agent_runtime` + `0009_*_guards`.
- API: `routes/workflows.ts` (agents, workflows, runs, approvals, executions, events + SSE);
  in-process worker `apps/api/src/worker.ts` (env `WORKER_ENABLED`, `WORKER_IDLE_MS`); shared budget-halt
  checkpoint handler `apps/api/src/budget-halt.ts`.

**Key rules**
- An agent actor's `agentKey` is its **role** (`AGENT_ROLES` in `packages/artifacts/src/access-policy.ts`),
  because context read/write permissions and `requireAgentTaskBinding` key on the role. The registry
  `agent_key` is used for model configuration (`routeAndInvoke({ agentKey })`).
- Agent output envelope (enforced by the runtime, `result` validated against the agent's `output_schema`):
  `{ status: completed|needs_input|failed, summary, artifacts: [{path,type,content}], handoff: {to_agent,
  decisions, assumptions, open_questions, required_actions}, result }`. Invalid output → bounded repair
  re-prompt (`retry_policy.maxOutputRepairs`, default 1) → otherwise the attempt fails.
- The runtime persists artifacts **as the agent actor** (role write areas enforced), then submits the
  handoff with hashed `output_refs`. It never changes task status: the scheduler does.
- Completion needs a passed gate evaluation (existing rule in `tasks.ts`): the scheduler records gate
  `agent_output_contract`; an approval stage additionally needs gate `human_approval`.
- Workflow definition = `{ stages: [{ key, agentKey, title, objective, dependsOn, when, approval,
  nextAgent, complexity, riskLevel, taskKind, maxRetries, ... }] }`. `when` is a condition on run
  variables (conditional branching: false ⇒ step `skipped`, its dependents no longer wait for it).
  Parallelism falls out of the task DAG. One task per active stage.
- Leases: `task_leases.task_id` is unique (idempotency guard). A worker's result is accepted only while
  its execution still holds the lease (`LeaseLostError` otherwise). Expired lease ⇒ execution
  `abandoned`, task back to `ready` (or `failed` when retries are exhausted).
- Failure handling in the scheduler: retryable ⇒ `failed → ready` with exponential backoff + jitter in
  `tasks.not_before`; exhausted ⇒ `failed` + `task.retries_exhausted` event; `BudgetBlockedError` ⇒ task
  back to `ready`, run paused (`budget_halted`); routing/invocation halts ⇒ `waiting_for_input`.
  Retries escalate complexity one level so a hybrid config may auto-upgrade the model.
- Approvals reuse permission `artifact.approve` (no RBAC change). Agents and system actors cannot decide.
- Deferred with a note in the report (not silently dropped): `agent_skills`, `agent_tool_permissions`
  (Phase 6 tool registry), separate `apps/worker` process (worker runs in-process in the API for now).

### Phase 4 (done) — what later phases need to know
- `@platform/model-router` → `routeAndInvoke(deps, actor, input)` is the **only** entry point for agent
  model calls. Input carries `agentKey`, `projectId/workflowId/taskId`, `complexity`, `riskLevel`,
  `taskKind`, `qualityGateCritical`, `essential`, `requiredCapabilities`. Result carries `routing`
  (explanation, fallbackUsed, attempts) and `budget` (`worstBand`, `optimizeContext`, `haltTriggered`).
- Errors a caller must handle: `BudgetBlockedError` (422 `budget_blocked`) → pause and ask a human;
  `RoutingHaltError` (422 `routing_halted`) → no valid model; `InvocationHaltedError` (502
  `invocation_halted`) → fallback chain stopped.
- `@platform/budget` → `checkBudgets`, `recordConsumption`, `upsertBudget`. `budget` must NOT import
  `context`; the halt checkpoint is an injected callback wired in `apps/api/src/routes/router.ts`.
- Budget bands: normal <50, optimize 50–70, warning 70–85, restrict 85–95 (non-essential blocked),
  halt ≥95 (budget `halted`, checkpoint saved, lifted when a human raises the limit via `PUT /budgets`).
- Hard ceilings = `model_routing_policies` row named `default`; no config scope can loosen them.
- Selection compares tier fit before score, so cost only breaks ties.
- **RBAC**: no permissions were added (changing RBAC needs human approval, Blueprint §20.7). Budgets and
  routing policies reuse `ai.config.read` / `ai.config.manage`; system-level writes are admin-only in code.
- **Commit/push only when the user asks.** Remote `origin` = https://github.com/nguyentrien17/AI_AGENT_SOFTWARE.git

## 4. Conventions that are easy to get wrong
- Stack: TypeScript, Node 22, Fastify 5 + TypeBox, Drizzle, PGlite for tests, Vitest. ESM with `.js` import suffixes.
- New package = `packages/<name>/package.json` (copy `packages/ai-management/package.json`), then
  `npm install` at the root to link the workspace.
- Schema change → generate migration (PowerShell, from `packages/db`):
  `$env:LOCALAPPDATA="$PWD\..\..\.tmp"; npx tsx ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`
  Triggers / append-only guards go in a separate hand-written migration created with
  `... generate --custom --name <name>`.
- Every state change: `audit(tx, actor, …)` + `emitEvent(tx, …)` in the same transaction.
- Mock provider `fetch` is allowed only in tests and must be labelled TEST-ONLY (Blueprint §20.3).
- After each phase: write `docs/reports/phase-N.md` in the §20.6 format and update the ledger.

## 5. Backlog
| Item | Notes |
|------|-------|
| Phase 6 | blocked on Docker (section 2) |
| Phase 7 | Developer + QA agents need Phase 6 tools; BA/Architect/Database/Review already in `agent-library/` |
| Phase 8, 9 | see roadmap; open risks per phase in `docs/reports/phase-N.md` |
| Web UI sprint | P1-14 web shell, P2-10 Context Explorer, P3-11 AI Management UI, P4-10 Usage & Costs UI, P5-12 Workflow/Agent dashboards. ADR-010 (React 19 + Vite) is still *Proposed* — needs user approval before starting |
| Live provider verification | no real API keys / Ollama on host; adapters verified only against fixtures |

## 6. Session log (newest first)
- 2026-11-10 — Phase 6 part A finished: tool-executor, runtime tool loop, tool API; 250 tests green. Pushed to GitHub on user request.
- 2026-11-10 — Phase 6A started. Fixed Phase 3 bug: adapters did not replay an assistant turn's tool calls, so providers would reject tool results (`ChatMessage.toolCalls`; test `ai-management/test/tool-history.test.ts`). Tool keys use underscores (`fs_read_file`) because provider function names forbid dots.
- 2026-11-10 — Phase 5 finished: API routes, SSE, in-process worker, report `docs/reports/phase-5.md`. 198 tests green. Phase 6 blocked: no Docker/WSL on host. Uncommitted.
- 2026-11-10 — Phase 5 core: agent-runtime, workflows, scheduler, approvals; gate tests green. Fixed 2 latent bugs: (a) Context Package cache key lacked task/project id → packages could be shared across tasks/projects (Phase 2); (b) adapters threw a provider error on non-JSON model text → tokens unbilled + needless fallback (Phase 3). Schema gotcha: `createdAt()` helper always names the column `created_at` — use explicit `timestamp('x')` for other timestamps.
- 2026-11-10 — Phase 4 finished: `packages/budget`, `packages/model-router`, `apps/api/src/routes/router.ts`, migrations 0006/0007, report written. Gate passed, 178 tests green. Uncommitted.
- 2026-11-10 — Phase 3 committed (`da032ed`). Phase 4 started: schema file written, this handoff file created.
