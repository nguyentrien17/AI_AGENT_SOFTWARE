# AI Agent Software Platform

Autonomous multi-agent software engineering platform built from
[`ai_agent_software_platform_technical_blueprint (1).md`](./ai_agent_software_platform_technical_blueprint%20(1).md).

- **Resume point for any AI coding agent (read first):** [`docs/HANDOFF.md`](docs/HANDOFF.md)
- **Docs index & state ledger:** [`docs/00-index/README.md`](docs/00-index/README.md)
- **Phase 0 artifacts:** [`docs/phase-0/`](docs/phase-0)
- **Task reports:** [`docs/reports/`](docs/reports)

## Stack (ADRs accepted 2026-11-10)
TypeScript · Node 22 · Fastify 5 + TypeBox · Drizzle ORM · PostgreSQL 16 (prod) / PGlite (local & tests) · Vitest.

## Requirements
- Node.js ≥ 22, npm ≥ 10, Git on `PATH`
- Docker (only from Phase 6 — sandboxed code execution)

## Setup
```powershell
npm install
npm run verify        # typecheck + lint + architecture rules + tests
npm run dev:api       # http://127.0.0.1:8787/api/v1
```
Or run `scripts/setup.ps1`.

First run: `POST /api/v1/auth/bootstrap` creates the platform owner and default workspace (only once).
OpenAPI 3.1 spec: `GET /api/v1/openapi.json`.

## Configuration (env)
| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `pglite://./data/pgdata` | `postgres://…` for PostgreSQL |
| `PLATFORM_DATA_DIR` | `./data` | |
| `PLATFORM_STORAGE_ROOT` | `./data/storage` | project workspaces live under `projects/<workspaceId>/<key>` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `LOG_LEVEL` | `info` | |

## Repository layout
See [`docs/phase-0/05-repo-structure.md`](docs/phase-0/05-repo-structure.md).

## Database migrations
Schema: `packages/db/src/schema`. Generate a migration after schema changes:
```powershell
cd packages/db; $env:LOCALAPPDATA="$PWD\..\..\.tmp"; npx tsx ../../node_modules/drizzle-kit/bin.cjs generate --name <name>
```
Migrations are applied automatically on API start.
