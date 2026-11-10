# Phase 2 — Shared Project Context Engine — Post-Task Reports

Format per Blueprint §20.6. Date: 2026-11-10. Token/cost usage: not reported by the environment.

---
## P2-01/02/03 — Context registry, access policy, concurrency
- **Created:** `packages/artifacts/src/access-policy.ts`.
- **Modified:** `packages/artifacts/src/artifacts.ts` (policy enforcement, `context_version` bump, immediate package invalidation, `context-map.json` sync, `loadVersionContent`, `findArtifactByPath`).
- **Policy (Blueprint §7.7):** per-area writer/reader matrix for 11 agent roles; humans may write only requirements, knowledge and documentation; `00-index`, `10-checkpoints`, `11-audit` are platform-managed; handoff folders writable only by the agent named in the folder. Agents must be bound to an `assigned`/`running` task of the same project assigned to their role.
- **Concurrency:** optimistic `expectedVersionNo` (from Phase 1) + row lock on approval.
- **Tests:** 16 policy matrix cases + integration. ✅

## P2-04 — Agent handoff schema validator
- **Created:** `packages/context/src/handoff.ts`.
- Strict TypeBox schema (schema_version 1.0, `additionalProperties: false`, length limits), explicit uuid/date-time checks, every `output_ref` must match a persisted version **and** SHA-256; handoff persisted as immutable artifact (`05-agent-handoffs/<from>/<task>/<id>.json`) + append-only `agent_handoffs` row; humans cannot forge handoffs; `handoff.created` event.
- **Tests:** 5 schema tests + integration (hash mismatch, impersonation, duplicate). ✅

## P2-05/06/07 — Context Package Builder, cache, invalidation
- **Created:** `packages/context/src/{builder,tokens,render}.ts`.
- Implements all 10 steps of Blueprint §7.4: explicit inputs → upstream dependency handoffs → role defaults; role read-permission check (required inputs fail fast, optional are recorded in `excluded`); latest-approved / pinned version resolution (a newer human-approved version supersedes a handoff pin); dedupe by version and by content hash; constraint memories injected; deterministic token estimate with budget enforcement (only optional items may be dropped, otherwise `context_budget_exceeded`); content hash verification before publishing; immutable manifest.
- **Cache key** = hash(task_spec_hash, artifact hashes, constraints hash, prompt_version, agent_role, model_config_version, budget); partial unique index guarantees one valid package per key; concurrent identical builds converge.
- **Invalidation:** inside the mutating transaction, every valid package whose `watched_paths` contains the mutated path is invalidated (artifact create/version/approve); constraint memories invalidate all project packages. Consumers receive `context_package_stale`.
- **Consumption:** `loadContextPackage` re-verifies every hash, enforces agent/task binding; `renderUntrustedContext` wraps content in `[UNTRUSTED_CONTEXT …]` blocks and neutralizes marker injection.
- **Tests:** cache key properties (7), injection neutralization, integration. ✅

## P2-08 — Checkpoints
- **Created:** `packages/context/src/checkpoints.ts`; `gitCommitAll` (serialized per repo) in `packages/projects/src/git.ts`.
- Transactionally consistent snapshot of all artifact versions/hashes + task statuses, hashed, written to `.ai-context/10-checkpoints/<id>.json`, committed to the project git repo; `verifyCheckpoint` detects missing/changed/tampered versions.
- **Tests:** create, git commit hash, verification, tamper detection. ✅

## P2 extra — Project memories
- **Created:** `packages/context/src/memories.ts` (decision / fact / constraint / lesson; archive; constraint changes invalidate packages).

## API (Blueprint §7.6)
`GET /projects/{id}/context` · `GET /projects/{id}/context/{contextId}` · `POST /projects/{id}/context/packages` · `GET /tasks/{id}/context` · `GET /context-packages/{id}` · `GET /projects/{id}/handoffs` · `GET /agent-handoffs/{id}` · `GET|POST /projects/{id}/memories` · `POST /memories/{id}/archive` · `GET|POST /projects/{id}/checkpoints` · `GET /checkpoints/{id}`.
> `POST /agents/{agent_id}/handoffs` is intentionally **not** exposed over HTTP yet: agents run inside the platform runtime and have no HTTP credentials until Phase 5 (Agent Runtime). Exposing it now would be a stub (§20.3).

## Database
Migrations `0002_shared_context.sql` (context_packages, context_package_items, agent_handoffs, checkpoints, project_memories, `projects.context_version`) and `0003_context_append_only.sql` (append-only triggers).

## Open issues & risks
| # | Item | Plan |
|---|------|------|
| R6 | `context-map.json` regenerated after commit; concurrent writers may briefly write an older map (DB stays authoritative) | regenerate from outbox consumer in worker (Phase 5) |
| R7 | Token estimate is a 4-bytes/token heuristic | provider tokenizers via Model Router (Phase 4) |
| R8 | Agent identity = role key until Agent Registry exists | Phase 5 maps versioned agents → roles |
| R9 | Checkpoint *restore* (resume) logic belongs to the Workflow Engine | Phase 5 |
| R10 | Context Explorer UI (P2-10) deferred with web shell (P1-14) | UI sprint after Phase 3 |

## Phase 2 Gate
**Passed** — `packages/context/test/context.test.ts` proves: Agent A writes versioned output → Context Manager builds package → Agent B consumes it without transcript → mutating the source artifact invalidates the cache (and rebuild reflects approval semantics); plus hash verification/tamper detection, permission denial, budget enforcement and checkpoint integrity.
