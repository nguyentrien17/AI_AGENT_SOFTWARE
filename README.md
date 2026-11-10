# AI Agent Software Platform

A platform where specialized AI agents — Business Analyst, Architect, Database Designer, Developer,
Reviewer — build software together through a controlled workflow: versioned artifacts instead of chat
transcripts, a model router with budgets, git-isolated tool use, quality gates and human approvals.

Built phase by phase from the [technical blueprint](./ai_agent_software_platform_technical_blueprint%20(1).md).
This README explains how to install, run and use it. For design details see [Documentation](#documentation).

> **Picking up development (human or AI)?** Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first: it holds the
> current state, the decisions already made, and the list of everything still pending.

---

## Contents
1. [Status: what works today](#1-status-what-works-today)
2. [Requirements](#2-requirements)
3. [Install and start](#3-install-and-start)
4. [Walkthrough: from zero to a running workflow](#4-walkthrough-from-zero-to-a-running-workflow)
5. [Configuration](#5-configuration)
6. [How it works](#6-how-it-works)
7. [API reference](#7-api-reference)
8. [Development](#8-development)
9. [Troubleshooting](#9-troubleshooting)
10. [Documentation](#documentation)

---

## 1. Status: what works today

| Area | Status |
|------|--------|
| Accounts, workspace roles (RBAC), projects, tasks, versioned artifacts, audit log | ✅ |
| Shared project context: hashed artifacts, handoffs, context packages, checkpoints | ✅ |
| AI providers (OpenAI-compatible incl. Ollama/vLLM/LM Studio, Anthropic, Gemini), encrypted keys, model registry, playground | ✅ |
| Model router (fixed / adaptive / hybrid), fallbacks, token & cost budgets, cost analytics | ✅ |
| Agent registry, workflows with branching/parallel stages, scheduler with leases and retries, human approvals, event stream | ✅ |
| Agent tools: file + git tools in an isolated git worktree per task, 7-dimension permission check | ✅ |
| Quality gates: secret scanning, merge-conflict check, integration stage, lineage/audit API | ✅ |
| **Running builds and tests of generated code** (sandbox) | ❌ needs Docker — not done yet |
| **Web user interface** | ❌ not built yet — use the HTTP API (examples below) |

What this means in practice: agents can analyse, design, write and commit code and get it reviewed, but
the implementation stage of the default workflow stops as **`blocked`** at its build/test gates until the
sandbox exists. That is intentional — the platform never marks work done without test evidence.
The full list of open items and the reason for each is in [`docs/HANDOFF.md` §5](docs/HANDOFF.md).

## 2. Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 22 | `node --version` |
| npm | ≥ 10 | comes with Node.js |
| Git | any recent (≥ 2.38 for merge checks) | must be on `PATH` |
| PostgreSQL | optional | without it an embedded PostgreSQL (PGlite) stores data in `./data` |
| Docker | not used yet | will be required for the sandbox (Phase 6 part B) |
| An AI model | at least one | an API key for OpenAI / Anthropic / Gemini, or a local [Ollama](https://ollama.com) |

## 3. Install and start

### 3.1 Get the code and install
```powershell
git clone https://github.com/nguyentrien17/AI_AGENT_SOFTWARE.git
cd AI_AGENT_SOFTWARE
npm install
npm run verify        # typecheck + lint + architecture rules + all tests (takes about a minute)
```
`scripts/setup.ps1` (Windows) and `scripts/setup.sh` (Linux/macOS) do the same and check your Node version.

### 3.2 Create your `.env`
```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Paste the printed value into `.env` as `PLATFORM_MASTER_KEY=...`. This key encrypts every AI provider API
key you store. **Back it up**: without it the stored provider keys cannot be decrypted. Never commit `.env`
(it is git-ignored). The API reads `<repo>/.env` automatically; variables already set in your shell win.

### 3.3 Start the API
```powershell
npm run dev:api
```
You should see `api listening` with `http://127.0.0.1:8787/api/v1`. The first start creates the database
and applies all migrations. The same process also runs the **worker** that executes workflow tasks
(disable with `WORKER_ENABLED=false`).

Check it: open http://127.0.0.1:8787/api/v1/health → `{"status":"ok"}`.
The complete API description (OpenAPI 3.1) is at http://127.0.0.1:8787/api/v1/openapi.json.

## 4. Walkthrough: from zero to a running workflow

All examples use PowerShell and keep the login cookie in `$s`. Run them in order in one PowerShell window.

```powershell
$api = 'http://127.0.0.1:8787/api/v1'
function Call($method, $path, $body) {
  $req = @{ Method = $method; Uri = "$api$path"; WebSession = $s }
  if ($method -ne 'Get') {
    $req.ContentType = 'application/json'
    $req.Body = if ($body) { $body | ConvertTo-Json -Depth 20 } else { '{}' }
  }
  Invoke-RestMethod @req
}
```

### Step 1 — Create the owner account (once) and log in
```powershell
Invoke-RestMethod -Method Post -Uri "$api/auth/bootstrap" -ContentType 'application/json' `
  -Body '{"email":"you@example.com","password":"choose-a-long-password","displayName":"You"}'

Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType 'application/json' -SessionVariable s `
  -Body '{"email":"you@example.com","password":"choose-a-long-password"}'
```
`bootstrap` works only on an empty platform and makes you the workspace owner. Add colleagues later with
`POST /users` (roles: `owner`, `administrator`, `project_manager`, `developer`, `reviewer`, `viewer`).

### Step 2 — Register the agents and the default workflow
```powershell
Call Post '/agents/seed'      # loads agent-library/skills/*.yaml, then agent-library/*.yaml: ba, architect, database, developer, review
Call Post '/workflows/seed'   # loads agent-library/workflows/*.yaml: sdlc-default
```
Running these again is safe: unchanged definitions are skipped, edited files become a new version.

### Step 3 — Connect an AI provider
Pick one. The API key is encrypted with your master key and never returned by the API.

```powershell
# OpenAI (or any OpenAI-compatible endpoint)
$p = Call Post '/ai/providers' @{ providerKey='openai'; displayName='OpenAI'; adapterType='openai_compatible';
                                  baseUrl='https://api.openai.com/v1'; apiKey='sk-...' }
# Anthropic
$p = Call Post '/ai/providers' @{ providerKey='anthropic'; displayName='Anthropic'; adapterType='anthropic';
                                  baseUrl='https://api.anthropic.com/v1'; apiKey='sk-ant-...' }
# Google Gemini
$p = Call Post '/ai/providers' @{ providerKey='gemini'; displayName='Gemini'; adapterType='gemini';
                                  baseUrl='https://generativelanguage.googleapis.com'; apiKey='AIza...' }
# Local Ollama (no real key needed; any placeholder works)
$p = Call Post '/ai/providers' @{ providerKey='ollama'; displayName='Local Ollama'; adapterType='openai_compatible';
                                  baseUrl='http://127.0.0.1:11434/v1'; apiKey='ollama' }

Call Post "/ai/providers/$($p.id)/test" @{ timeoutMs = 10000 }   # expect result = connection_successful
```

### Step 4 — Register a model and describe what it can do
Either import the provider's model list (`POST /ai/providers/{id}/sync-models`; imported models start with
unknown capabilities and tier) or register one yourself:

```powershell
$m = Call Post '/ai/models' @{
  providerId = $p.id; modelKey = 'gpt-4.1'; availability = 'available'
  qualityTier = 'high'                       # economy | standard | high | frontier
  contextWindow = 128000; maxOutputTokens = 16384
  capabilities = @{ tool_calling = 'yes'; structured_output = 'yes' }
  pricing = @{ inputPerMtok = '2.00'; outputPerMtok = '8.00'; verified = $true }   # optional, USD per 1M tokens
}
```
Agents need `structured_output` (they answer in JSON) and the Developer needs `tool_calling`. Without
pricing, costs are reported as unknown — the platform never invents prices.

### Step 5 — Assign the model to agents
```powershell
Call Put '/ai/configurations' @{ scope = 'global'; mode = 'fixed'; primaryModelId = $m.id }
Call Post '/ai/router/resolve' @{ agentKey = 'developer' }   # dry run: which model would be used, and why
```
Scopes override each other in this order: **task > workflow > project > agent > global**. For example, give
only the Architect a stronger model with `scope='agent'; agentKey='architect'`. Modes:
`fixed` (always the primary), `adaptive` (best model of an allowlist for each task), `hybrid` (primary by
default, upgrades for complex work). Optional safety limits: `PUT /budgets` (token/cost budgets) and
`PUT /ai/routing-policies` (workspace-wide ceilings).

### Step 6 — Create a project and write your request
```powershell
$proj = Call Post '/projects' @{ key = 'todo-app'; name = 'Todo App' }

$req = Call Post "/projects/$($proj.id)/artifacts" @{
  path = '.ai-context/01-requirements/request.md'; type = 'request'
  content = "# Todo app`nUsers can add, complete and delete todo items. Items are stored per user."
}
Call Post "/artifacts/$($req.item.id)/versions/$($req.version.versionNo)/approve"
```
Every project gets its own folder and git repository under `data/storage/projects/...`. The default
workflow reads your request from exactly this path, and only an **approved** version is given to agents —
so write it and approve it before you start a run. To change it later, add a version with
`POST /artifacts/{id}/versions` (`content`, `expectedVersionNo`) and approve that one.

### Step 7 — Start the workflow
```powershell
$wf  = (Call Get '/workflows').items | Where-Object key -eq 'sdlc-default'
$run = Call Post "/projects/$($proj.id)/workflow-runs" @{
  workflowId = $wf.id
  variables  = @{ change_type = 'feature'; touches_database = $true }   # bugfix skips analysis and design
}
$run.steps | Select-Object stageKey, status
```
The worker picks up ready tasks within seconds: Business analysis → System design → Database design →
Implementation → Integration → Code review.

### Step 8 — Follow progress and answer the agents
```powershell
Call Get "/workflow-runs/$($run.run.id)" | Select-Object -ExpandProperty steps | Select-Object stageKey, status, taskId
Call Get "/projects/$($proj.id)/tasks" | Select-Object -ExpandProperty items | Select-Object title, status, statusReason
Call Get "/projects/$($proj.id)/events?limit=50"     # or stream: GET /projects/{id}/events/stream (Server-Sent Events)
```
What the statuses mean for you:

| Status | What to do |
|--------|-----------|
| `waiting_for_approval` | Review and decide (below). Analysis and design stop here for a human sign-off. |
| `waiting_for_input` | Read `statusReason` (the agent's questions or a routing problem), fix the cause, then `Call Post "/tasks/<id>/transitions" @{ to = 'ready' }` |
| `blocked` | A quality gate cannot pass (secret found, merge conflict, or a gate that needs the sandbox). Read `statusReason`. |
| `failed` | Retries exhausted; the failure context is in `GET /tasks/{id}/executions`. |

Approve or reject:
```powershell
$pending = (Call Get "/projects/$($proj.id)/approvals?status=pending").items
Call Post "/approvals/$($pending[0].id)/decision" @{ decision = 'approved'; comment = 'Looks good' }
# a rejection needs a comment; the agent redoes the work with your comment as feedback:
Call Post "/approvals/$($pending[0].id)/decision" @{ decision = 'rejected'; comment = 'Add offline support' }
```

### Step 9 — Inspect the results
```powershell
Call Get "/projects/$($proj.id)/artifacts"          # requirements, architecture, schemas, reviews (versioned)
Call Get "/tasks/<taskId>/workspace/diff"           # code written by the Developer (git diff of task/<taskId>)
Call Get "/tasks/<taskId>/lineage"                  # who/why/which model/which files/which tools/which gates/who approved
Call Get "/ai/costs/breakdown?groupBy=agent"        # tokens and estimated cost per agent
```
Generated code lives in git: each task on branch `task/<taskId>`, integrated work on branch `integration`
of the project repository.

## 5. Configuration

Set in `<repo>/.env` or the shell. Relative paths are resolved from the repository root.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PLATFORM_MASTER_KEY` | — (**required** to store provider keys) | 32-byte key, base64 or 64 hex chars |
| `PLATFORM_MASTER_KEY_VERSION` | `1` | Version of the current master key (for rotation) |
| `PLATFORM_MASTER_KEY_PREVIOUS` | — | Older keys still able to decrypt: `1:<key>,2:<key>` |
| `DATABASE_URL` | `pglite://./data/pgdata` | `postgres://user:pass@host:5432/db` for PostgreSQL |
| `PLATFORM_DATA_DIR` | `./data` | Default home of the database and storage |
| `PLATFORM_STORAGE_ROOT` | `./data/storage` | Project folders, git repositories, task worktrees, evidence |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listening address |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per-client request limit |
| `ALLOWED_ORIGINS` | — | Extra browser origins allowed to change data (CSRF check), e.g. `https://platform.example.com`. Same-origin and localhost pages are always allowed |
| `AGENT_LIBRARY_DIR` | `./agent-library` | Source of `POST /agents/seed` and `POST /workflows/seed` |
| `WORKER_ENABLED` | `true` | Run the task worker inside the API process |
| `WORKER_IDLE_MS` | `2000` | Worker poll interval when idle |

Rotating the master key: set the new key as `PLATFORM_MASTER_KEY`, bump `PLATFORM_MASTER_KEY_VERSION`, and
list the old one in `PLATFORM_MASTER_KEY_PREVIOUS` until every provider key has been re-saved.

## 6. How it works

### Agents (`agent-library/*.yaml`)
An agent definition has instructions, an output JSON schema, allowed tools/actions/file scopes and retry
policy — **never a model**; the router picks the model at run time. Editing a file and re-seeding creates a
new immutable version. Every agent answers with a JSON envelope (`status`, `summary`, `artifacts`,
`handoff`, `result`); invalid answers get one bounded repair attempt. Each agent may only write its own
area of `.ai-context/` (e.g. the BA writes `01-requirements/`, the Architect `02-architecture/`).

### Skills (`agent-library/skills/*.yaml`)
A skill is a reusable, versioned block of instructions (e.g. `secure-coding`, `adr-writing`). An agent
lists skills with `skills: [...]`; their latest versions are added to its trusted instructions, and the
exact agent and skill versions used are recorded with every context package.

### Workflows (`agent-library/workflows/*.yaml`)
A workflow is a list of stages: `key`, `agentKey`, `title`, `objective`, `dependsOn` (stages without a
dependency path between them run in parallel), `when` (condition on run variables, e.g.
`{ var: change_type, in: [feature] }`), `approval: human`, `gates`, `maxRetries`, `inputRefs`, and
`kind: integration` for the merge stage. Cycles are rejected before anything runs.

### Context, not chat
Agents never see each other's conversations. Each task gets a **context package**: the exact versions
(with SHA-256) of the artifacts it needs, built from its inputs and the handoffs of upstream tasks, marked
as untrusted data and kept separate from the agent's instructions.

### Model routing and budgets
For every call the router applies hard filters (allowlist, capabilities, health, context window, quality
tier, budget, workspace ceilings), scores the remaining models and records why it chose one. Temporary
provider failures fall back to the next allowed model; authentication errors, budget exhaustion or quality
violations stop and ask a human. When a fallback would switch to another provider and the configuration
sets `requireApprovalForProviderChange`, the task waits for a human approval of kind `provider_change`. Budgets warn at 70 %, restrict non-essential work at 85 % and halt with a
checkpoint at 95 %; raising the limit (`PUT /budgets`) resumes work.

### Tools and safety
Agents touch files only through tools (`fs_*`, `git_*`) inside a git worktree of their own task. Every call
passes a 7-dimension permission check (project, agent, task, tool, file scope, action, risk), is confined to
the worktree (no `..`, absolute paths, links out, `.git/` or `.ai-context/`), and is logged. Destructive git
operations are refused; high-risk tools need a human approval per call.

### Quality gates
A task is never completed on the agent's word. On completion the platform runs the gates — secret scan of
the added lines, merge-conflict check, plus the stage's own gates — and stores evidence for each (tool,
command, git tree hash, raw log). A failed gate sends the work back to the agent with the reason; a gate
that needs the sandbox (`build`, `lint`, `unit_tests`, …) reports `blocked` until the sandbox exists.

## 7. API reference

Base URL `http://127.0.0.1:8787/api/v1`. Authentication by session cookie (`POST /auth/login`). Errors use
RFC 7807 (`application/problem+json`) with a machine-readable `code`. Full schema: `GET /openapi.json`.

| Area | Main endpoints |
|------|----------------|
| Auth & users | `GET /auth/status` · `POST /auth/bootstrap` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `GET/POST /users` · `GET /audit-logs` |
| Projects | `GET/POST /projects` · `GET /projects/{id}` · members, settings, requirements, user stories |
| Artifacts & context | `GET/POST /projects/{id}/artifacts` · `GET /artifacts/{id}/versions` · `GET /projects/{id}/context` · handoffs · checkpoints · memories |
| Tasks | `GET/POST /projects/{id}/tasks` · `POST /tasks/{id}/transitions` · `GET /tasks/{id}/executions` · `GET /tasks/{id}/tool-executions` · `GET /tasks/{id}/workspace/diff` · `GET /tasks/{id}/lineage` |
| AI management | `/ai/providers` (+ `/test`, `/sync-models`, `/credential`) · `/ai/models` (+ `/pricing`, `/test`) · `/ai/configurations` · `/ai/playground/run` · `/ai/playground/compare` |
| Routing & cost | `POST /ai/invocations` · `POST /ai/router/resolve` · `GET /ai/fallback-events` · `GET/PUT /ai/routing-policies` · `GET/PUT /budgets` · `GET /ai/usage` · `GET /ai/costs/breakdown` |
| Agents & workflows | `GET/POST /agents` · `POST /agents/seed` · `POST /agents/{id}/versions` · `GET/POST /workflows` · `POST /workflows/seed` |
| Runs & approvals | `POST /projects/{id}/workflow-runs` · `GET /workflow-runs/{id}` · `POST /workflow-runs/{id}/pause\|resume\|cancel` · `GET /projects/{id}/approvals` · `POST /approvals/{id}/decision` |
| Events | `GET /projects/{id}/events` · `GET /projects/{id}/events/stream` (SSE, resumes with `Last-Event-ID`) |
| Checkpoints | `GET/POST /projects/{id}/checkpoints` · `GET /checkpoints/{id}` (verify) · `POST /checkpoints/{id}/restore` (never deletes history; creates branch `restore/<id>`) |
| Skills | `GET /skills` |
| Tools | `GET /tools` |

Writes accept an `Idempotency-Key` header so retried requests are not applied twice. Lists of tasks,
artifacts, workflow runs and approvals are paginated: pass `?limit=` and the returned `nextCursor` as
`?cursor=`. Writes from a browser page on another origin are rejected unless listed in `ALLOWED_ORIGINS`.

## 8. Development

```powershell
npm run verify        # everything CI runs
npm test              # tests only (Vitest); npx vitest run packages/budget  → one package
npm run test:watch
npm run typecheck
npm run lint
npm run depcheck      # architecture rules (.dependency-cruiser.cjs)
npm run format
```
Tests use an in-memory PostgreSQL (PGlite) and scripted, clearly labelled fake model responses — no API
key or network is needed. CI (`.github/workflows/ci.yml`) runs the same checks on every push.

### Repository layout
```
apps/api/                 HTTP API (Fastify) + in-process worker
packages/
  shared  db  storage  observability  iam      foundations: ids, errors, schema/migrations, storage, logging, RBAC
  projects  artifacts  context                 projects, versioned artifacts, context packages, handoffs, checkpoints
  ai-management  model-router  budget          providers/models/keys, routing + fallbacks, budgets + costs
  agent-runtime  orchestration                 agent registry + runtime, workflows, scheduler, approvals, lineage
  tool-executor  quality-gates                 agent tools, permission guard, git worktrees, gates + secret scan
agent-library/            agent definitions (*.yaml) and workflows/ (*.yaml)
docs/                     HANDOFF.md, design (phase-0/), phase reports (reports/)
```
Rules worth knowing: packages never import `apps/`; only `tool-executor` may start processes; every state
change writes an audit record and an outbox event in the same transaction; test-only fakes must be
labelled `TEST-ONLY`.

### Changing the database schema
Edit `packages/db/src/schema/*.ts`, then generate a migration (PowerShell, from `packages/db`):
```powershell
cd packages/db
$env:LOCALAPPDATA = "$PWD\..\..\.tmp"
npx tsx ../../node_modules/drizzle-kit/bin.cjs generate --name <change_name>
# triggers / guards go in a hand-written migration:
npx tsx ../../node_modules/drizzle-kit/bin.cjs generate --custom --name <change_name>_guards
```
Migrations are applied automatically when the API starts. Timestamp columns other than `created_at` need an
explicit `timestamp('<name>')` — the `createdAt()` helper always names its column `created_at`.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `PLATFORM_MASTER_KEY is not configured` when adding a provider | Set it in `.env` (step 3.2) and restart the API |
| `already_bootstrapped` | The owner already exists; log in instead |
| Provider test returns `unknown_error` / `timeout` | Wrong `baseUrl`, no network, or Ollama not running. Fix it and run the test again — a successful test also clears the provider's `failing` health |
| `routing_halted` with `provider_unhealthy` | A failed connection test marked the provider unhealthy. Re-run `POST /ai/providers/{id}/test` once it is reachable |
| `routing_halted` with `missing_capability:structured_output` | Mark the model's capabilities (`PATCH /ai/models/{id}`) or pick another model |
| Task stays `waiting_for_input` with a routing or provider message | Fix the provider/model, then `POST /tasks/{id}/transitions` with `{ "to": "ready" }` |
| A task is `waiting_for_input` with `Required context artifact … not found` or `… has no approved version` | Write and approve `.ai-context/01-requirements/request.md` (step 6), then move the task to `ready`. No retry was spent |
| Implementation ends `blocked` with `sandbox_unavailable` | Expected until the sandbox is built — see [Status](#1-status-what-works-today) |
| `budget_blocked` | A budget is exhausted: raise it with `PUT /budgets`, then resume the run (`POST /workflow-runs/{id}/resume`) |
| Port 8787 in use | Set `PORT` in `.env` |
| Start over with an empty platform | Stop the API and delete the `data/` folder (this deletes all projects and keys) |

## Documentation

| Document | Content |
|----------|---------|
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Current state, decisions, pending work — start here when continuing development |
| [`docs/00-index/README.md`](docs/00-index/README.md) | Phase ledger and package map |
| [`docs/phase-0/`](docs/phase-0) | Requirements, ADRs, architecture, database, API map, security model, roadmap |
| [`docs/reports/`](docs/reports) | What each phase delivered, tests run, open risks |
| [Technical blueprint](./ai_agent_software_platform_technical_blueprint%20(1).md) | The specification the platform is built from |
