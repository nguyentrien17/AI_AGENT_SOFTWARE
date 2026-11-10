# 02 — Architecture Decision Records

Status legend: **Proposed** (awaiting human approval) · Accepted · Superseded.

---
## ADR-001 Platform core language: TypeScript on Node.js 22 LTS — *Proposed*
**Context:** Need one language for API, workers, adapters and UI; host already has Node 22.
**Decision:** TypeScript (strict) everywhere in platform core; target projects remain polyglot via sandbox runtimes.
**Alternatives:** Python/FastAPI (strong AI ecosystem, but split stack with UI); PHP/Laravel (PHP 7.4 on host is EOL); Go (not installed).
**Consequences:** shared DTO/JSON-Schema types between backend & frontend; single toolchain.

## ADR-002 Monorepo with npm workspaces + Turborepo-free scripts — *Proposed*
**Decision:** npm workspaces (pnpm not installed). Packages per bounded context, apps for API/worker/web.
**Consequences:** enforce no circular deps via `dependency-cruiser` in CI.

## ADR-003 HTTP framework: Fastify 5 + TypeBox (JSON Schema) — *Proposed*
**Decision:** Fastify with TypeBox schemas → OpenAPI 3.1 generated automatically; RFC 7807 error handler.
**Alternatives:** NestJS (heavier DI), Express (no native schema validation).

## ADR-004 Database: PostgreSQL 16 (prod) / PGlite (local & tests) + Drizzle ORM — *Proposed*
**Context:** Blueprint suggests PostgreSQL; host lacks Postgres & Docker.
**Decision:** Drizzle ORM with SQL migrations targeting PostgreSQL. Local-first mode uses **PGlite** (embedded Postgres in WASM, same SQL dialect) so the platform runs with zero external services; production/hybrid uses real PostgreSQL via `DATABASE_URL`.
**Keys:** UUIDv7 primary keys; `version` column for optimistic locking; `workspace_id` on tenant-scoped tables.

## ADR-005 Event dispatch & jobs: transactional outbox table + DB-backed job queue — *Proposed*
**Decision:** `system_events` outbox written in the same transaction as state changes; a worker polls with `FOR UPDATE SKIP LOCKED`. No Kafka/Redis in MVP (blueprint §7.8).

## ADR-006 File storage & versioning: local FS + per-project Git repo — *Proposed*
**Decision:** `StorageAdapter` interface (local FS impl; S3 later). Each project has a Git repo; `.ai-context/` artifacts are committed; DB stores version metadata + SHA-256. Writes are atomic (temp file + rename), DB row committed after file hash verified.

## ADR-007 Provider adapters: native HTTP adapters, no vendor SDK lock-in — *Proposed*
**Decision:** `ProviderAdapter` interface (`capabilities()`, `listModels()`, `probe()`, `invoke()`, `stream()`). MVP adapters: **OpenAI-compatible** (covers OpenAI, Ollama, LM Studio, vLLM, many gateways), **Google Gemini**, **Anthropic**. Each normalizes to internal `InvocationRequest/Result`.
**Consequence:** satisfies "≥1 cloud + 1 local" gate (Gemini/OpenAI + Ollama).

## ADR-008 Credential encryption: AES-256-GCM envelope encryption — *Proposed*
**Decision:** Master key from env/OS keystore (`PLATFORM_MASTER_KEY`); per-credential random DEK encrypted by master key; `SecretStore` interface allows Vault/AWS SM later. UI receives only masked hint (`sk-****abcd`).

## ADR-009 Sandbox: Docker containers via `SandboxAdapter`; no host-execution fallback — *Proposed*
**Decision:** Docker Engine with per-task ephemeral containers (`--network none` default, cpu/mem/pids limits, read-only rootfs + workspace bind mount, non-root user, no secrets). Interface allows Podman/Firecracker later.
**Risk:** Docker not installed on dev host → Phase 6 blocked until installed (Docker Desktop / Rancher Desktop / WSL2 Podman). **No unsandboxed fallback** will be implemented (blueprint §11.3).

## ADR-010 Web UI: React 19 + Vite + TanStack Query/Router + shadcn/ui — *Proposed*
**Decision:** SPA served by API in local mode; real-time updates via Server-Sent Events from the outbox.

## ADR-011 Authentication: local accounts (argon2id) + session cookies; OIDC later — *Proposed*

## ADR-012 Testing: Vitest (unit/integration on PGlite), Playwright (E2E UI) — *Proposed*
Mock provider adapters exist **only** under `test/` and are explicitly labeled (blueprint §20.3).

## ADR-013 Agent definitions stored as versioned YAML in `agent-library/` and seeded to DB — *Proposed*
DB rows in `agent_versions` are immutable; editing creates a new version. System instructions separated structurally from untrusted context blocks.

## ADR-014 Routing scoring: rule-based filter → weighted scoring, fully explained — *Proposed*
Hard filters (allowlist, capabilities, health, context window, output limit, budget, quality tier) then score (quality tier fit, cost, latency). Every decision persists a `routing_explanation` JSON. Cheapest-only selection is forbidden.
