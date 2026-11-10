# Phase 0 (P0-09) & Phase 1 — Post-Task Reports

Format per Blueprint §20.6. Dates: 2026-11-10. Token/cost usage: not reported by the environment.

---
## P0-09 — Repository foundation
1. **Objective:** git repo, npm workspaces monorepo, strict TS, ESLint, Prettier, Vitest, dependency-cruiser boundary rules, CI, README, setup scripts.
2. **Created:** `package.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.env.example`, `vitest.config.ts`, `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`, `README.md`, `scripts/setup.ps1`, `scripts/setup.sh`.
3. **Modified:** `docs/phase-0/02-adrs.md` (ADRs → Accepted).
4. **DB/API:** none.
5. **Tests:** `npm run verify` green (typecheck, lint, depcruise, tests).
6. **Risks:** `drizzle-kit` needs `LOCALAPPDATA` redirect + `tsx` loader on this host (documented in README).
7. **Docs:** README, index ledger.
9. **Status:** ✅ completed.

## P1-01 — `@platform/shared`
Created `packages/shared/src/{ids,errors,redact,hash,types,index}.ts`. UUIDv7 (monotonic), RFC 7807 error hierarchy, secret redaction (key- and value-pattern based + runtime registered secrets), `maskSecret`, SHA-256 + canonical JSON hashing, `Actor` model. **Tests:** 10 passing. ✅

## P1-02/03 — `@platform/db` + IAM schema
Created Drizzle schema (`packages/db/src/schema/*`) for workspaces, users, workspace_members, sessions, idempotency_keys, projects, project_members, project_settings, repositories, project_environments, requirements, user_stories, acceptance_criteria, context_items, context_versions, tasks, task_dependencies, task_status_history, quality_gate_evaluations, audit_logs, system_events.
Migrations: `0000_init.sql` (generated), `0001_append_only_guards.sql` (triggers: audit_logs / task_status_history / quality_gate_evaluations append-only; context_versions content immutable, approved→draft forbidden; purge only with `app.allow_purge='on'`).
Driver factory: `postgres://` (node-postgres) or `pglite://memory|<dir>`. **Tests:** 4 passing (constraints, triggers). ✅
**Schema addition vs blueprint:** `task_status_history` (append-only transition log, needed for lineage questions §17).

## P1-04/05/06 — Auth, RBAC, workspaces (`@platform/iam`)
argon2id passwords (min 12 chars), one-time owner bootstrap (advisory lock), session tokens stored as SHA-256 only, 12h TTL, revocation on logout/member removal, timing-equalized login. RBAC matrix (6 roles × 19 permissions), project-scoped effective role (non-admins need membership; cross-workspace access returns 404/403), owner-role escalation guard, last-owner protection, cursor-paginated audit query. **Tests:** 13 passing incl. full role matrix. ✅

## P1-07/08 — Projects, members, settings, requirements (`@platform/projects`)
Project creation scaffolds the full Blueprint §7.2 `.ai-context/` tree + `git init` (argv-only), transactional with filesystem rollback; archive/restore (hard delete deferred to Phase 8 approval workflow — Blueprint §16.3); optimistic concurrency on project/settings; requirements/stories/AC lifecycle `draft→in_review→approved→superseded`, approval permission, approved = immutable. **Tests:** 8 passing. ✅

## P1-09 — `@platform/storage`
`StorageAdapter` + `LocalStorage`: path jail (absolute, drive letters, `..`, NUL, junction/symlink escape), atomic write (temp+fsync+rename), content-addressed blob store with integrity verification on read. **Tests:** 10 passing, 1 skipped (junction creation not permitted in this sandbox; runs on normal hosts). ✅

## P1-10 — Artifact Manager (`@platform/artifacts`)
Versioned artifacts restricted to `.ai-context/` and `documentation/` (index files reserved); immutable versions with SHA-256 + blob URI; optimistic concurrency via `expectedVersionNo`; human-only approval with supersede chain and row lock; tamper detection on read; `artifact.created/versioned/approved` events. **Tests:** 13 passing. ✅

## P1-11 — Task Manager (`@platform/orchestration`)
Strict state machine (all 11 statuses), human vs system transition split (humans cannot assign/run/complete), `completed` requires latest evaluation of every gate = `passed`, bounded retries (cap 10, `failed→ready` blocked when exhausted), DAG with cycle detection, auto-promotion `pending→ready`, cancellation blocks dependents, append-only history. **Tests:** 8 passing. ✅

## P1-12/13 — Audit logger, outbox, idempotency, HTTP API (`@platform/observability`, `apps/api`)
Redacting JSON logger; transactional audit + outbox writes. Fastify API with TypeBox validation (strict bodies), RFC 7807 errors (`application/problem+json`), deny-by-default auth hook, httpOnly SameSite=Strict session cookie, `Idempotency-Key` (replay / 422 on reuse / no caching of 5xx), rate limits (global + login/bootstrap), OpenAPI 3.1 at `/api/v1/openapi.json`. Endpoints: see `docs/phase-0/06-api-map.md` (Phase 1 rows).
**Tests:** Phase 1 gate e2e (9 tests) incl. **process restart on persistent PGlite with full state recovery**. ✅

## P1-14 — Web shell
⏳ Not started (next task). Backend gate is satisfied independently.

---
## Open issues & technical risks
| # | Item | Plan |
|---|------|------|
| R1 | Docker not installed → Phase 6 blocked | install Docker Desktop / Rancher Desktop before Phase 6 |
| R2 | Collection endpoints other than audit logs return full lists (bounded per project) | add cursor pagination to tasks/artifacts when lists grow (Phase 5) |
| R3 | Response schemas not declared → OpenAPI documents requests only | add response schemas with contracts package (Phase 2) |
| R4 | Outbox dispatcher (worker) not yet implemented — events accumulate as `pending` | `apps/worker` in Phase 2 (cache invalidation consumer) |
| R5 | CSRF relies on SameSite=Strict + JSON-only bodies | add Origin check middleware before any non-localhost deployment |

## Phase 1 Gate
**Passed** — end-to-end persistence, retrieval and state recovery of projects and tasks verified by automated tests (`apps/api/test/api.e2e.test.ts`), plus 69 unit/integration tests across packages.
