# 09 — Key Decisions Requiring Human Approval (Phase 0 Gate)

Phase 1 will **not** start until these are approved or amended.

| # | Decision | Proposal | Alternatives |
|---|----------|----------|--------------|
| D1 | Platform core stack (ADR-001/003/010) | TypeScript · Node 22 · Fastify · React/Vite | Python/FastAPI + React; PHP/Laravel (needs PHP 8.2+) |
| D2 | Database (ADR-004) | PostgreSQL 16 via Drizzle; **PGlite** embedded for local/test (no install needed) | Install PostgreSQL locally; SQLite (diverges from PG features) |
| D3 | Sandbox (ADR-009) | Docker; install Docker Desktop / Rancher Desktop before Phase 6; no host fallback | Podman on WSL2 |
| D4 | MVP providers (ADR-007) | OpenAI-compatible (incl. Ollama) + Gemini + Anthropic | Fewer adapters (min 2 required) |
| D5 | Tenancy | Single default workspace in UI for MVP, but `workspace_id` scoping in schema from day 1 | Full multi-workspace UI in MVP |
| D6 | Cost | `estimated_cost` from admin-verified price table; `actual_cost` null unless provider reports it | — |
| D7 | Package manager | npm workspaces (pnpm absent) | Install pnpm |
| D8 | Docs language | English (matches blueprint); chat reports in Vietnamese | Vietnamese docs |

Schema additions vs. blueprint §13 (for approval): IAM tables (`workspaces`, `users`, `workspace_members`, `sessions`, `idempotency_keys`), `agent_model_allowlist`, `quality_gate_evaluations`.
