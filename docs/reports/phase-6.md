# Phase 6 — Tool Executor & Isolated Sandbox — Post-Task Reports

Format per Blueprint §20.6. Date: 2026-11-10. Token/cost usage: not reported by the environment.

**Status: part A done (everything that needs no container). Part B (sandbox) not started — the dev host has
no Docker and no WSL. The Phase 6 gate is therefore still OPEN.** User decision 2026-11-10: do part A now,
part B later.

---
## A0 — Schema & migrations
- **Created:** `packages/db/src/schema/tools.ts` — `tool_registry`, `tool_permissions` (the ERD's `agent_tool_permissions`; subject `agent_version` or `role`), `tool_executions`; migrations `0010_tool_executor.sql`, `0011_tool_executor_guards.sql` (`tool_executions` append-only).
- Not created yet: `sandbox_sessions`, `sandbox_artifacts` (part B).

## P6-01 — Tool registry (`packages/tool-executor/src/catalog.ts`)
Tools are code (`ToolDefinition`: key, description, input/output JSON Schema, action, scopes, timeout, risk, idempotency, sandbox flag, redaction policy, runtimes, path fields). `syncToolRegistry` publishes the catalog to `tool_registry` idempotently (definition hash). Tool keys use underscores because provider function names forbid dots.

## P6-02 — Permission guard (`permissions.ts`)
Pure `evaluateToolPermission` over the 7 dimensions of Blueprint §16.2 — project, agent, task (running + lease held by this execution), tool (agent `allowed_tools` ∩ task `allowed_tools`), file scope (globs), action (`allowed_actions`), risk (≤ `tool_permissions.max_risk`, default `medium`). Deny by default; every dimension is reported. A per-tool row can only narrow file scopes. `high`/`critical` risk always returns `require_approval`.

## P6-03 — Path jail (`jail.ts`)
Rejects absolute paths, drive letters, UNC, NUL, `..`, Windows trailing-dot/space and `:` stream segments, and the protected areas `.git/` and `.ai-context/` (the latter is versioned only through the Artifact Manager). Resolves real paths so symlinks/junctions cannot lead outside the workspace or into a protected area, and fails closed on dangling links.

## P6-04 — File tools (`tools/fs.ts`)
`fs_read_file` (size cap, binary detection), `fs_list_dir` (never follows links, hides protected areas and anything outside the agent's scopes), `fs_write_file` (atomic, size cap, re-checks the jail after creating parents), `fs_delete_file` (files only).

## P6-05 — Git (`git.ts`, `tools/git.ts`, `process.ts`)
- Each task works in its own git worktree on branch `task/{taskId}` under `<storage>/worktrees/…`, created on first tool use (re-attached after a crash).
- Tools: `git_status`, `git_diff` (vs. the merge base, untracked included, literal pathspecs), `git_commit`, `git_log`, `git_check_merge` (pre-merge conflict detection with `git merge-tree`, no working tree touched).
- `runGit` is the only way git runs: argv only, no shell, hooks disabled, sanitized environment (no platform secrets reach the child), timeout with process-tree kill, output caps. Destructive operations (force push, `reset --hard`, branch/tag delete, `clean`, rebase, history rewrite, …) are refused unless an approval id is passed; no agent tool exposes them.

## Executor & runtime integration
- `executeTool`: schema validation → path normalization → 7-dimension decision → sandbox check (sandbox tools report `sandbox_unavailable`, ADR-009: no host fallback) → worktree → jailed handler with timeout → `tool_executions` row with redacted input (file contents omitted) and summarized output; denials and approval requests also audited. An agent's mistake is returned as an outcome, never thrown.
- Agent runtime: bounded tool-call loop (max 25 calls per attempt). Tools are offered only when the agent version allows them (∩ task). Tool results go back as `tool` messages, treated as untrusted data.
- API: `GET /tools`, `GET /tasks/{id}/tool-executions`, `GET /tasks/{id}/workspace/diff`. The in-process worker gets the tool catalog; the API syncs `tool_registry` at start-up.

## Bug found in an earlier phase and fixed
| Phase | Bug | Fix |
|-------|-----|-----|
| 3 | No adapter replayed an assistant turn's tool calls, so OpenAI, Anthropic and Gemini would all reject the follow-up tool results — agents could not use tools with a real provider. | `ChatMessage.toolCalls`; each adapter serializes calls and groups results as its API requires. Regression test `packages/ai-management/test/tool-history.test.ts`. |

## Tests executed
`npm run verify` — typecheck, ESLint, dependency-cruiser (no violations, 155 modules), Vitest: **25 files, 250 tests passed** (198 after Phase 5, +52).
New: `packages/tool-executor/test/unit.test.ts` (39), `executor.test.ts` (7), `packages/ai-management/test/tool-history.test.ts` (3), `apps/api/test/tools.e2e.test.ts` (3).
Escape tests that need no container: path traversal, absolute/UNC/drive paths, `.git` and `.ai-context` writes, NTFS streams, junction out of the workspace, junction into `.git`, dangling junction, destructive git, secret-free child environment.

## Open issues & risks
| # | Item | Plan |
|---|------|------|
| R26 | **Part B not done:** Docker `SandboxAdapter` + CPU/RAM/PID/time limits, runtime images, terminal/test-runner tools, log streaming, container escape tests, `sandbox_sessions`/`sandbox_artifacts` | Needs Docker/Podman (WSL 2) or a remote Linux host |
| R27 | `require_approval` tool calls are refused; no approval request is raised yet | Phase 8 approvals for kind `tool_call` |
| R28 | Task worktrees are never cleaned up automatically | Phase 7 integration/merge stage (P7-08) removes them after merge |
| R29 | File tools run on the host (inside the jail). They only read/write files and never execute them; code execution waits for the sandbox | By design, ADR-009 |

## Phase 6 Gate
**Not passed yet.** The gate requires a sample Node + Python project built and tested inside the sandbox plus container escape tests (network, host fs, secrets env). The parts that do not need a container are implemented and tested above.
