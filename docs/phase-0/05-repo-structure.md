# 05 — Proposed Monorepo / Directory Structure

```
AgentCode/                         # repository root (AI-Software-Platform)
├── apps/
│   ├── api/                       # Fastify HTTP API + SSE, serves web build in local mode
│   ├── worker/                    # orchestrator loop, job runner, outbox dispatcher
│   └── web/                       # React + Vite SPA
├── packages/                      # platform-core bounded contexts
│   ├── shared/                    # ids (uuidv7), errors (RFC7807), result, clock, redaction
│   ├── contracts/                 # TypeBox/JSON schemas, DTOs, handoff & manifest schemas
│   ├── db/                        # Drizzle schema, migrations, seeders, PGlite/PG factory
│   ├── storage/                   # StorageAdapter (local FS), atomic writes, sha256
│   ├── iam/                       # auth, sessions, workspaces, RBAC policy engine
│   ├── projects/                  # projects, members, requirements, stories, AC
│   ├── artifacts/                 # Artifact Manager: versioned, hashed, approvable artifacts
│   ├── ai-management/             # providers, credentials (SecretStore), model registry, probes
│   │   └── adapters/              # openai-compatible, gemini, anthropic
│   ├── model-router/              # precedence resolver, routing engines, fallback FSM
│   ├── budget/                    # budgets, usage ledger, pricing, thresholds
│   ├── context/                   # handoffs, context manager, package builder, cache, memories, checkpoints
│   ├── agent-runtime/             # registry, versioned definitions, execution runtime, handoffs
│   ├── orchestration/             # orchestrator, workflow engine, DAG scheduler, leases, checkpoints, approvals
│   ├── tool-executor/             # tool registry, permission guard, path jail, built-in tools
│   ├── sandbox/                   # SandboxAdapter (docker)
│   ├── quality-gates/             # gate engine, evidence capture, scanners integration
│   └── observability/             # structured logger, audit logger, traces, metrics
├── agent-library/                 # versioned agent definitions (YAML) + prompts + skills
├── infrastructure/                # docker images for sandbox runtimes, compose for PG (optional)
├── docs/
│   ├── 00-index/                  # index + state ledger (read first)
│   ├── phase-0/                   # foundational artifacts
│   ├── adr/                       # one file per ADR once accepted
│   └── reports/                   # post-task reports
├── projects/                      # runtime data: per-project workspaces (gitignored)
│   └── <project-key>/{.ai-context/, source-code/, tests/, documentation/, artifacts/}
├── scripts/                       # setup/dev scripts (PowerShell + sh)
├── .github/workflows/ci.yml       # lint, typecheck, test, dep-cruiser
├── package.json                   # npm workspaces
├── tsconfig.base.json
└── README.md
```

Blueprint mapping: `platform-core/` → `packages/*` + `apps/*`; `ai-management/` → `packages/ai-management`; `agent-library/` kept; `tool-executor/` → `packages/tool-executor` + `packages/sandbox`; `infrastructure/` kept; `projects/` kept with the exact `.ai-context/` tree of Blueprint §7.2.
