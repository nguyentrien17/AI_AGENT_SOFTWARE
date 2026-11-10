# Phase 4 — Model Router & Token Budget Manager — Post-Task Reports

Format per Blueprint §20.6. Date: 2026-11-10. Token/cost usage: not reported by the environment.

---
## P4-00 — Schema & migrations
- **Created:** `packages/db/src/schema/budgets.ts` (`token_budgets`, `budget_events`, `fallback_events`, enums `budget_level`, `budget_threshold_band`), migrations `0006_router_budget.sql`, `0007_router_budget_append_only.sql`.
- **Modified:** `packages/db/src/schema/ai.ts` (unique index `model_routing_policies_ws_name_uq`), `schema/index.ts`.
- **Notes:** token counters are `bigint`; `budget_events` and `fallback_events` are append-only (trigger `platform_reject_mutation`).

## P4-08 — Budget Manager (`packages/budget`)
- **Created:** `src/bands.ts`, `src/budgets.ts`, `src/analytics.ts`, `test/budget.test.ts`.
- **Capabilities (Blueprint §10.1, §10.4):**
  - Five-level hierarchy: system → project → workflow → task, plus a per-invocation cap. One budget per level + scope; token limit and/or cost limit.
  - Bands with configurable thresholds: normal <50 · optimize 50–70 · warning 70–85 · restrict 85–95 · halt ≥95 · exhausted ≥100.
  - `checkBudgets` — read-only pre-flight over the whole hierarchy: reports tightest headroom, blocks on halt/exhaustion, blocks non-essential work in the restrict band, blocks an invocation whose worst case would exceed a limit.
  - `recordConsumption` — charges every covering budget, appends each band crossing to `budget_events`, and on entering the halt band flags the budget `halted`, calls the injected `onHalt` checkpoint hook, audits `budget.halted` and emits the `budget.halted` outbox event.
  - `upsertBudget` — raising a limit is the human approval that lifts a halt (`budget.resumed`).
  - Cost limits are never checked against a guessed price: without pricing the check is skipped and noted.
- **Tests:** 9 (band matrix, custom thresholds, hierarchy pre-check, every threshold, halt + checkpoint, exhaustion + resume, failing checkpoint hook, append-only ledger). ✅

## P4-01…P4-05 — Model Router selection (`packages/model-router`)
- **Created:** `src/policy.ts`, `src/selection.ts`, `test/selection.test.ts`.
- **Capabilities (Blueprint §4.2, §4.3, §5.1–5.3):**
  - **P4-01 precedence:** reuses `resolveEffectiveModelConfig` (Task > Workflow > Project > Agent > Global).
  - **P4-02 ceiling overlay:** workspace routing policy `default` — `maxOutputTokens`, `maxCostPerInvocationUsd`, `minQualityTier`, `deniedModelIds`, `allowedProviderIds`, `requireApprovalForProviderChange`; rules for minimum tier by risk level and for high-reasoning task kinds. No configuration scope can loosen them.
  - **P4-03 hard filters:** allowlist, policy denials, provider enabled/health, model availability, required capabilities, context window, max output, minimum quality tier, cost ceiling, remaining token/cost budget, provider-change approval. Every rejection is named.
  - **P4-04 scoring:** quality fit 0.5, cost 0.2, provider health 0.2, capability certainty 0.1. Tier fit is compared *before* the score, so cost can only break ties — a model is never selected solely for being cheapest.
  - **P4-05 engines:** `fixed` (primary or halt), `adaptive` (best eligible model of the allowlist), `hybrid` (primary by default; auto-upgrade for complex work; auto-downgrade for simple work only when allowed, cheaper, and no Quality Gate or high-reasoning task is at stake).
  - No valid model → `RoutingHaltError` (422 `routing_halted`) with the reason and every candidate's rejections.
- **Tests:** 18 pure tests. ✅

## P4-06 — Fallback state machine
- **Created:** `src/fallback.ts` (pure `classifyFailure`, `nextFallbackStep`).
- **Capabilities (Blueprint §5.4):** triggers = timeout, 429, model unavailable / 5xx, transient network, runtime capability mismatch. Bounded same-model retries (`limits.maxRetries`, exponential backoff) before switching. Halts on authentication failure, non-retryable error, exhausted budget, fallback outside allowlist, fallback below minimum quality tier, provider change needing approval, no capable fallback, chain exhausted.
- **Ledger:** every switch and every halt is appended to `fallback_events` (cause, original model, fallback model, attempt count) and audited.

## P4-07 — Routed invocation (`routeAndInvoke`)
- **Created:** `src/router.ts`, `test/router.test.ts`.
- **Flow:** resolve route → budget pre-check → dispatch through the provider adapter with the fallback FSM → write `model_invocations` / `token_usage` / `cost_records` → charge budgets → audit `ai.routing.decided` with the full explanation. Failed attempts are recorded as failed invocations; pre-dispatch halts are audited as `ai.routing.halted`.
- **Modified:** `POST /ai/invocations` now goes through the router (response is a superset of the Phase 3 shape, adding `routing` and `budget`). `invokeForAgent` in `@platform/ai-management` remains exported but is no longer used by the API.
- **Tests:** 12 integration tests on PGlite with a labelled TEST-ONLY scripted provider. ✅

## P4-09 — API
`POST /ai/invocations` (routed) · `POST /ai/router/resolve` (dry-run) · `GET /ai/fallback-events` · `GET|PUT /ai/routing-policies` · `GET|PUT /budgets` · `GET /budgets/{id}/events` · `GET /ai/costs/breakdown` (filters: provider, model, agent, project, workflow, task, from, to; `groupBy` provider|model|agent|project|workflow|task|day).
- **Created:** `apps/api/src/routes/router.ts`, `apps/api/test/router.e2e.test.ts`.
- **Modified:** `apps/api/src/app.ts`, `apps/api/src/routes/ai.ts`, `apps/api/package.json`.
- The API wires the budget halt hook to `createCheckpoint` (system actor `budget-manager`), so a halted project budget leaves a verifiable checkpoint.

## Tests executed
`npm run verify` — typecheck, ESLint, dependency-cruiser (no violations, 119 modules), Vitest: **18 files, 178 tests passed** (132 before Phase 4, +46).

## Open issues & risks
| # | Item | Plan |
|---|------|------|
| R15 | P4-10 Usage & Costs UI not built | Web UI sprint with P1-14, P2-10, P3-11 |
| R16 | Provider change "requires approval" can only block; there is no approval workflow yet | Phase 5 approvals manager (P5-09) |
| R17 | Budget halt stops new invocations but nothing pauses running workflows yet | Phase 5 scheduler must consume the `budget.halted` outbox event |
| R18 | Budgets reuse `ai.config.read` / `ai.config.manage`; no dedicated `budget.*` permissions | Needs human approval to change RBAC (Blueprint §20.7) |
| R19 | Token estimate before dispatch is `chars / 4`, not a tokenizer | Replace when the Context Package Builder supplies counts (Phase 5) |
| R20 | `actual_cost` is always null — no provider billing API is integrated | Post-MVP |
| R14 | Live provider calls still unverified (no API keys / Ollama on host) | Unchanged from Phase 3 |

## Phase 4 Gate
**Passed** — `apps/api/test/router.e2e.test.ts` and the two package suites prove:
- **Precedence matrix:** all five levels resolve in order, and removing a level exposes the next one down.
- **Allowlist violation blocked:** adaptive routing halts instead of leaving the allowlist; a fallback outside the allowlist halts the invocation.
- **Each fallback trigger and prohibited scenario:** timeout, 429, 5xx, capability mismatch switch model; auth failure, budget exhaustion, tier violation, allowlist violation, no capable fallback halt.
- **Budget thresholds incl. halt + checkpoint:** every band crossing is logged; the halt saves a verifiable project checkpoint, blocks further invocations with `budget_blocked`, and resumes when a human raises the limit.
- **Routing explanation in audit for every invocation:** every agent invocation row is covered by an `ai.routing.decided`, `ai.routing.fallback` or `ai.routing.halted` audit record.
