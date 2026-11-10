# Phases 7 & 8 — work done without a sandbox — Post-Task Reports

Format per Blueprint §20.6. Date: 2026-11-10. Token/cost usage: not reported by the environment.
User instruction (2026-11-10): note everything that cannot be done yet, do everything that can.
**Neither phase gate is passed**: both need the sandbox (Phase 6 part B) to build and test generated code.

---
## P8-02 — Secret / credential leak scanner (`packages/quality-gates/src/secrets.ts`)
Offline, pattern based: private keys, AWS, GitHub, Anthropic, OpenAI-style, Google, Slack, Stripe live keys, JWTs, credentials in URLs, hard-coded password/secret/api-key assignments. Placeholders and env lookups are ignored. Only lines a task **added** are scanned (unified diff vs. merge base). Findings carry file, line, rule and a masked preview — never the secret.

## P8-01 — Quality Gate engine (`packages/quality-gates/src/gates.ts`, `orchestration/src/scheduler.ts`)
- Every attempt that finished `completed` runs the default workspace gates (`secret_scan`, `merge_check`) plus the stage's `gates`.
- Evidence per gate (Blueprint §12.4): tool, version, exact command, environment id, git tree hash of the work, raw output stored as a content-addressed blob, summary.
- `failed` → bounded retry with the gate summary fed back to the agent; `blocked` / `requires_approval` → task `blocked` and `task.needs_intervention` event; only all-passed proceeds to the output-contract gate, approval or completion.
- Gates that execute project code (`build`, `lint`, `unit_tests`, `dependency_scan`, `migration_check`) report `blocked` with `sandbox_unavailable` — never skipped, never assumed.

## P7-08 — Integration stage
Stage `kind: integration` (no agent). The platform merges the run's completed task branches, in stage order, into the `integration` branch in its own worktree (`tool-executor/src/integration.ts`). A conflict aborts the merge (nothing lost), blocks the task for a human and emits `integration.conflict` with the files. Evidence gate `integration_merge`.

## P8-05 — Approvals for high-risk tool calls (R27)
`tool-executor/src/approvals.ts`: a `require_approval` tool call opens (or reuses) an approval of kind `tool_call` keyed by task + tool + input hash. The runtime parks the task (`waiting_for_input`); a human decision reschedules it; an approved call runs **once** (the approval id is recorded on the tool execution).

## P8-06 — Lineage API
`GET /tasks/{id}/lineage` (permission `audit.read`) answers the eight Blueprint §17 questions: why (objective, stage, upstream, received handoffs), who scheduled (creator, run starter, every transition with actor), model + parameters + routing rationale + tokens/cost, exact context package files (path/version/hash), tool calls, workspace diff + output artifacts, quality gates with evidence, human approvals with decider.

## P7-01…07 — Agents and default workflow
- New `agent-library/developer.yaml` (tools, scopes `source-code/**`, `tests/**`, no secrets rule).
- New `agent-library/workflows/sdlc-default.yaml`: BA → Architect (approval) → Database (only when `touches_database`) → Developer (gates build/lint/unit_tests) → Integration → Review (approval). `change_type: bugfix` skips analysis and design.
- `seedWorkflowLibrary` + `POST /workflows/seed`; publishing an identical workflow definition is now a no-op.

## P8-07 — Concurrency tests
Eight workers racing for three tasks: each task claimed once, one running execution and one lease each. A heartbeat that beats recovery keeps the lease; four concurrent recoverers recover an expired task exactly once.

## Tests executed
`npm run verify` — typecheck, ESLint, dependency-cruiser (no violations, 166 modules), Vitest: **28 files, 268 tests passed** (250 before, +18).
New: `quality-gates/test/secrets.test.ts` (9), `orchestration/test/quality.test.ts` (6), `orchestration/test/library-concurrency.test.ts` (3), lineage assertions in `apps/api/test/tools.e2e.test.ts`.

## Not done (see `docs/HANDOFF.md` §5 for the live register)
| Item | Why |
|------|-----|
| QA agent; build/lint/unit-test gates that actually run; P7-09 test-failure repair loop | need the sandbox |
| P8-03 dependency vulnerability scan, P8-04 migration up/down validation | process or execute untrusted project files → sandbox |
| P7-10 sample app from a prompt (Phase 7 gate), MVP pillars 6–7 end to end | sandbox + a real model API key |
| R16 approval request for a provider change | todo — reuse the approvals table with kind `provider_change` |
| Web UI (P1-14, P2-10, P3-11, P4-10, P5-12, approval UI) | todo — stack approved (D1); needs UI dependencies installed |
