# Part B — Hardening, Pending Backend Items & Web UI — Post-Task Report

Format per Blueprint §20.6. Date: 2026-11-10. Requested by the user ("làm phần B").
Token/cost usage: not reported by the environment.
Commits: `67d41f1` (backend B2–B7), `dbb3b39` (B1 Web UI), plus the follow-up commit with this report
(Costs smoke-test fix, README Web UI section).

---
## B3 — Remove task worktrees after integration (R28)
- **Modified:** `packages/orchestration/src/scheduler.ts` (`runIntegrationClaim`), `packages/projects/src/git.ts`.
- Once the integration stage has merged the `task/*` branches, it removes their worktrees. The branches are
  kept, so history and lineage stay intact.
- **Tests:** `packages/orchestration/test/workflow.test.ts`. ✅

## B4 — Approval for provider change on fallback (R16)
- **Modified:** `packages/model-router/src/{router,fallback,selection}.ts`, `packages/orchestration/src/approvals.ts`.
- A fallback halt with reason `provider_change_requires_approval` opens an approval of kind `provider_change`
  (subject: from/to provider and model). `decideApproval` reschedules the task (same flow as `tool_call`).
  The router then allows a provider that has an approved request for that task.
- **Tests:** `packages/orchestration/test/quality.test.ts`. ✅

## B2 — CSRF Origin check, cursor pagination, OpenAPI response schemas (R5, R2, R3)
- **Created:** `apps/api/src/csrf.ts`, `apps/api/src/response-schemas.ts`; `toPage` in `packages/shared`.
- **CSRF:** a state-changing request that carries `Origin`/`Referer` must match the API's own origin
  (localhost/127.0.0.1) or `ALLOWED_ORIGINS`. Requests without either header (curl, PowerShell) are allowed.
- **Pagination:** `?limit=&cursor=` on task, artifact, workflow-run and approval lists; the response is
  `{ items, nextCursor }` (UUIDv7 ids are time-ordered).
- **OpenAPI:** every route documents RFC 7807 problem responses; the routes the UI uses also document their
  success responses.
- **Tests:** `apps/api/test/csrf.test.ts`, `apps/api/test/pagination.e2e.test.ts`. ✅

## B5 — Outbox dispatcher + `context-map.json` resync (R4, R6)
- **Created:** `packages/observability/src/outbox.ts`, `apps/api/src/outbox-handlers.ts`; migration `0012_outbox_claims.sql`.
- `dispatchOutboxBatch` claims `pending` events with a lease, runs the handlers outside the claim
  transaction, then marks each event `dispatched`, or retries it and finally marks it `failed`. The
  in-process worker runs it. Artifact events re-sync `context-map.json`.
- **Tests:** `packages/observability/test/outbox.test.ts`. ✅

## B6 — Checkpoint restore (R9)
- **Modified:** `packages/context/src/checkpoints.ts` (`restoreCheckpoint`); route `POST /checkpoints/{id}/restore`.
- Restore never deletes history:
  - each artifact gets a new version containing the checkpoint's content (matched by content hash);
  - items created after the checkpoint are reported, not removed;
  - a git branch `restore/<checkpointId>` is created at the checkpoint commit.
- **Tests:** `packages/context/test/restore.test.ts`. ✅

## B7 — Agent skills (R21, Blueprint §6.3)
- **Created:** `packages/agent-runtime/src/skills.ts`, `agent-library/skills/*.yaml`; migrations `0013_agent_skills.sql`,
  `0014_agent_skills_guards.sql` (immutable versions); route `GET /skills`.
- An agent version lists `skills`. The runtime appends those skills' instructions to the trusted system
  instruction, and the prompt version records the exact skill versions used.
- **Tests:** agent-runtime and workflow tests. ✅

## B1 — Web UI (P1-14, P2-10, P3-11, P4-10, P5-12, P8-05 approval UI)
- **Created:** `apps/web`: React 19, Vite, TanStack Query + Router (code-based routes), Tailwind 4, and
  shadcn-style primitives written in `src/components/ui.tsx` (ADR-010). API types live in
  `src/api/types.ts`; the web app never imports server packages.
- **Pages:**
  - sign-in / first-run owner setup;
  - Projects;
  - Project: request editor + approval, start / pause / resume / cancel runs, steps, tasks, artifacts,
    approvals (approve, or reject with a comment), live events over SSE;
  - Task: lineage, attempts, model calls with the routing reason, context, tool calls, gates, approvals, diff;
  - AI: providers, models, assignments, budgets;
  - Agents & workflows: agents, workflows, skills;
  - Costs.
- **Hosting:**
  - The API serves `apps/web/dist` at `/` with an SPA fallback (`@fastify/static`, `WEB_DIST_DIR`), so the
    UI and API are same-origin and need no CORS or CSRF exceptions.
  - `/api` routes always take precedence.
  - Dev mode: `npm run dev:web` on :5173, which proxies `/api` to the API.
- **Checks:**
  - `npm run typecheck` also covers `apps/web/tsconfig.json`; `npm run verify` also runs `build:web`.
  - `apps/api/test/web.e2e.test.ts` covers UI hosting, SPA fallback, traversal and API precedence.
  - `scripts/ui-smoke.mjs` drives headless Edge through the Chrome DevTools Protocol, with no extra
    dependencies.

### Costs page "renders blank" — root cause and fix
- **Symptom (reported at the end of the previous session):** the smoke step `costs page` timed out
  waiting for "Model calls".
- **Root cause:** the page was not blank. The stat labels use Tailwind `uppercase`, and
  `document.body.innerText` applies CSS `text-transform`, so the page text read `MODEL CALLS`. The
  smoke script matched case-sensitively. The API call and the rendering were both correct; the dumped
  page text showed totals and the "By agent" table.
- **Fix:**
  - `scripts/ui-smoke.mjs`: `waitFor` matches case-insensitively. The costs step now also checks
    "Estimated cost", the empty-table text, and switching the grouping to "by model".
  - `apps/web/src/pages/Costs.tsx`: the group-by selector has a visible "Group by" label (accessibility;
    the smoke script uses it to find the field).
- **Verification:** UI built, then the API started on a fresh data dir and the smoke script run:
  **11/11 steps `ok`, JS problems: none.**

## README
New section **3.4 Open the web interface** covers:
- build and open the UI;
- what each page does;
- dev mode on :5173;
- the browser smoke test.

Other README updates: the status table, the walkthrough note, `WEB_DIST_DIR` in the configuration table,
the repository layout, and a troubleshooting row (UI not built when the API started).

## Verification
- `npm run verify`: typecheck (incl. web), lint and dependency rules (193 modules, 0 violations) clean;
  **34 test files / 287 tests**: 286 passed, 1 skipped (storage symlink test without symlink rights). The
  tool-executor symlink escape test needs symlink permission: it fails with `EPERM` inside a restricted
  agent sandbox and **passes (7/7) in a normal shell**. Web build OK.
- `node scripts/ui-smoke.mjs http://127.0.0.1:8797` against a fresh API: all 11 steps `ok`.

## Open issues & risks
| # | Item | Plan |
|---|------|------|
| R29 | No automated component tests for the web UI (only build + API hosting tests + the manual-run browser smoke script) | Add Vitest + Testing Library, or run `ui-smoke.mjs` in CI with a browser image |
| R30 | The smoke script needs a Chromium-based browser and loopback access, so it is not part of `npm run verify` | Keep it as a manual/CI step; `EDGE_PATH` selects the browser |
| R31 | Web UI has no Playground screen and no provider key rotation form yet (both exist in the API) | Add with the next UI pass |
| — | Phase 6 part B (sandbox), P8-03/P8-04, QA agent, P7-10, R14 live provider check | **blocked**: see `docs/HANDOFF.md` §5 |
| R18 | Dedicated `budget.*` permissions | Needs human approval (RBAC change, Blueprint §20.7) |
