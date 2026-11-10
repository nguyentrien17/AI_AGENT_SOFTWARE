# AI Agent Software Platform — Documentation Index & State Ledger

> **Resuming work? Read [`../HANDOFF.md`](../HANDOFF.md) first** — it holds the current task checklist and next step.

Source of truth: `../../ai_agent_software_platform_technical_blueprint (1).md` (Blueprint v1.0).

## Phase 0 Artifacts

| # | Artifact | File | Status |
|---|----------|------|--------|
| 1 | Requirements Analysis & Domain Model | [01-requirements-domain.md](../phase-0/01-requirements-domain.md) | approved |
| 2 | Architecture Decision Records | [02-adrs.md](../phase-0/02-adrs.md) | approved (ADR-001…014 accepted) |
| 3 | System Architecture & Components | [03-architecture.md](../phase-0/03-architecture.md) | approved |
| 4 | Database ERD & Schema Spec | [04-database-schema.md](../phase-0/04-database-schema.md) | approved |
| 5 | Monorepo / Directory Structure | [05-repo-structure.md](../phase-0/05-repo-structure.md) | approved |
| 6 | REST API Domain & Endpoint Map | [06-api-map.md](../phase-0/06-api-map.md) | approved |
| 7 | Security, Credential & Sandbox Model | [07-security-model.md](../phase-0/07-security-model.md) | approved |
| 8 | Roadmap (Phases → atomic tasks) | [08-roadmap.md](../phase-0/08-roadmap.md) | approved |
| 9 | Phase Verification & Acceptance | [08-roadmap.md](../phase-0/08-roadmap.md#phase-gates) | approved |
| — | Decisions requiring Human Approval | [09-approval-decisions.md](../phase-0/09-approval-decisions.md) | approved (D1–D8, 2026-11-10) |

## Implementation State Ledger

| Phase | Status | Gate |
|-------|--------|------|
| 0 — Discovery & Foundation | ✅ done (incl. P0-09 repo foundation) | passed (human approval 2026-11-10) |
| 1 — Core Platform Foundation | ✅ backend done (P1-01…P1-13); P1-14 web shell pending | **passed** — [reports/phase-1.md](../reports/phase-1.md) |
| 2 — Shared Context Engine | ✅ done (P2-01…P2-09); P2-10 Context Explorer UI pending | **passed** — [reports/phase-2.md](../reports/phase-2.md) |
| 3 — AI Management | ✅ done (P3-01…P3-10); P3-11 AI Management UI pending | **passed** — [reports/phase-3.md](../reports/phase-3.md) |
| 4 — Model Router & Budget | ✅ done (P4-01…P4-09); P4-10 Usage & Costs UI pending | **passed** — [reports/phase-4.md](../reports/phase-4.md) |
| 5 — Agent Runtime & Orchestration | ✅ done (P5-01…P5-11); P5-12 dashboards pending | **passed** — [reports/phase-5.md](../reports/phase-5.md) |
| 6 — Tool Executor & Sandbox | 🟡 part A done (P6-01…P6-05 + runtime tool loop); part B (P6-06…P6-10 sandbox) **blocked: no Docker / WSL** | open — [reports/phase-6.md](../reports/phase-6.md) |
| 7 — Specialized Agents | not started | — |
| 8 — Quality Gates & Hardening | not started | — |
| 9 — Advanced (post-MVP) | not started | — |

## Package Map (implemented)
| Package | Responsibility |
|---------|----------------|
| `packages/shared` | UUIDv7, RFC 7807 errors, redaction, hashing, Actor |
| `packages/db` | Drizzle schema, migrations, PG/PGlite factory |
| `packages/storage` | jailed local storage, atomic writes, blob store |
| `packages/observability` | redacting logger, audit log, outbox events |
| `packages/iam` | auth, sessions, RBAC policy, workspace members, audit query |
| `packages/projects` | projects, members, settings, requirements/stories/AC, workspace scaffold |
| `packages/artifacts` | versioned, hashed, approvable artifacts (`context_items`/`context_versions`) + agent-role context access policy |
| `packages/context` | handoffs, Context Package Builder/cache/invalidation, untrusted-context rendering, memories, checkpoints |
| `packages/ai-management` | envelope-encrypted secret store, OpenAI/Gemini/Anthropic adapters, 7-state probe, model registry/capabilities/pricing, 5-scope agent model configs + runtime dispatcher, isolated AI Playground |
| `packages/budget` | budget hierarchy, threshold bands, pre-check, consumption ledger, halt + checkpoint hook, cost analytics |
| `packages/model-router` | routing policy / hard ceilings, hard filters, scoring, fixed/adaptive/hybrid engines, fallback FSM, routed invocation |
| `packages/agent-runtime` | agent registry + immutable versions, YAML seeding, output contract, agent execution runtime |
| `packages/tool-executor` | tool catalog + registry sync, 7-dimension permission guard, path jail, fs tools, git worktrees/tools + destructive guard, executor + tool log |
| `packages/orchestration` | task state machine, DAG, gate-guarded completion, workflows + conditional engine, scheduler (leases, recovery, retries, backoff), approvals, event feed |
| `apps/api` | Fastify HTTP API `/api/v1` |

> Note: `packages/artifacts` was added to the structure in 05-repo-structure.md (Artifact Manager, Phase 1 scope).

## Environment Snapshot (2026-11-10)

Node 22.19 / npm 10.9 · Python 3.13.5 · Git 2.50 · PHP 7.4 · **Docker: not found** · **WSL: not installed** · **PostgreSQL: not found** (PGlite used) · pnpm: not found.
