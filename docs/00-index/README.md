# AI Agent Software Platform — Documentation Index & State Ledger

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
| 3 — AI Management | next | — |
| 4 — Model Router & Budget | not started | — |
| 5 — Agent Runtime & Orchestration | not started | — |
| 6 — Tool Executor & Sandbox | not started (blocked: Docker not installed on dev host) | — |
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
| `packages/orchestration` | task state machine, DAG, gate-guarded completion |
| `apps/api` | Fastify HTTP API `/api/v1` |

> Note: `packages/artifacts` was added to the structure in 05-repo-structure.md (Artifact Manager, Phase 1 scope).

## Environment Snapshot (2026-11-10)

Node 22.19 / npm 10.9 · Python 3.13.5 · Git 2.50 · PHP 7.4 · **Docker: not found** · **PostgreSQL: not found** (PGlite used) · pnpm: not found.
