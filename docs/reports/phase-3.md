# Phase 3 — AI Management Module — Post-Task Reports

Format per Blueprint §20.6. Date: 2026-11-10. Token/cost usage: not reported by the environment.

---
## P3-01 — Secret Store & Envelope Encryption
- **Created:** `packages/ai-management/src/secret-store.ts`.
- **Modified:** `packages/shared/src/errors.ts` (`UnprocessableError` extensions support).
- **Capabilities (ADR-008, Blueprint §3.2 & §12.1):**
  - AES-256-GCM envelope encryption using a random 256-bit DEK and 96-bit IV per credential, wrapped with the active 256-bit master KEK (`PLATFORM_MASTER_KEY`, base64 or 64-char hex) and its own 96-bit IV + GCM auth tag.
  - Multi-version keyring (`PLATFORM_MASTER_KEY_VERSION`, `PLATFORM_MASTER_KEY_PREVIOUS`) with `rewrap()` for zero-downtime master key rotation.
  - Automatically registers plaintext secrets with `@platform/shared` redactor (`registerSecret`) and returns only `maskedHint` (`sk-p…1122`).
- **Tests:** `packages/ai-management/test/ai-management.test.ts` (distinct IV/DEK, redaction scrubbing, key rotation, tamper rejection, missing master key guard). ✅

## P3-02 — AI Provider Registry & Credential Lifecycle
- **Created:** `packages/ai-management/src/providers.ts`.
- **Modified:** `packages/iam/src/policy.ts` (added `ai.provider.read`, `ai.provider.manage`, `ai.model.read`, `ai.model.manage`, `ai.config.read`, `ai.config.manage`, `ai.playground.run`).
- **Capabilities:** Provider CRUD, enable/disable, `rotateProviderCredential` / `revokeProviderCredential`, URL hygiene validation (no embedded credentials or query strings), and internal `resolveProviderConnectionContext` for adapter dispatch. Plaintext API keys and ciphertexts are never returned by any API endpoint or written to `audit_logs`.
- **Tests:** unit + E2E (`apps/api/test/ai.e2e.test.ts` verifies zero occurrences of plaintext keys across HTTP responses, `ai_provider_credentials`, and `audit_logs`). ✅

## P3-03/04/05 — Provider Adapters (OpenAI-Compatible, Gemini, Anthropic)
- **Created:** `packages/ai-management/src/adapters/{types,openai-compatible,gemini,anthropic,index}.ts`.
- **Capabilities (Blueprint §3.1, §4.4, §7.7):**
  - Normalized `ProviderAdapter` contract (`declaredCapabilities`, `listModels`, `probe`, `invoke`).
  - `OpenAiCompatibleAdapter`: `/v1/models` and `/v1/chat/completions` (covers OpenAI, Ollama `/v1`, vLLM, LM Studio).
  - `GeminiAdapter`: `/v1beta/models` and `/v1beta/models/{model}:generateContent` using `x-goog-api-key` header (never URL query parameter).
  - `AnthropicAdapter`: `/v1/models` and `/v1/messages` using `x-api-key` and `anthropic-version`.
  - Strict separation of `untrustedContext` from `systemInstruction` across all three adapters.
  - Pre-flight capability guard (`validateRequestedCapabilities`) preventing dispatch of `tools`, `jsonSchema`, or `reasoningEffort` when model capability is `'no'`.
- **Tests:** contract + fixture tests for all 3 adapters in `packages/ai-management/test/ai-management.test.ts`. *(Note per §20.3: automated tests use labeled test-only mock `fetch` fixtures; live external provider endpoints remain unverified until real API keys / local Ollama are supplied by the user).* ✅

## P3-06 — Connection Probe & 7-State Classification
- **Created:** `probeProviderConnection` and `listConnectionTests` in `packages/ai-management/src/providers.ts`; `classifyHttpFailure` in `packages/ai-management/src/adapters/types.ts`.
- **Capabilities (Blueprint §3.4):** Classifies all 7 required states (`connection_successful`, `authentication_failed`, `model_unavailable`, `rate_limited`, `timeout`, `unsupported_capability`, `unknown_error`), records immutable `ai_connection_tests` + `probe` telemetry in `model_invocations`, and updates `ai_providers.healthStatus` (`healthy`, `degraded`, `failing`) and `ai_models.availability`.
- **Tests:** all 7 probe classifications verified in `packages/ai-management/test/ai-management.test.ts`. ✅

## P3-07/08 — Model Registry, Capability Matrix & Append-Only Pricing
- **Created:** `packages/ai-management/src/models.ts`.
- **Capabilities (Blueprint §3.3, §10.2):**
  - Manual model registration (`createModel`), provider model discovery (`syncModelsFromProvider`), capability verification (`updateModel`), and append-only price history (`addModelPricing`).
  - Never guesses unknown capabilities or pricing (`metadataVerified: false`, capabilities default to `'unknown'`).
  - `computeEstimatedCost` computes `estimatedCost` from `ai_model_pricing` and always keeps `actualCost: null` unless verified billing data is supplied.
- **Tests:** sync discipline, capability updates, and pricing calculation verified in unit + E2E tests. ✅

## P3-09 — Agent Model Configuration & Dynamic Runtime Dispatcher
- **Created:** `packages/ai-management/src/configs.ts`.
- **Capabilities (Blueprint §4.2, §4.3, §4.5):**
  - Configuration CRUD across all 5 scopes (`global`, `project`, `workflow`, `agent`, `task`) with `allowlistModelIds`, ordered `fallbackModelIds`, capability validation, `configVersion` increment, and immutable `agent_model_config_history` snapshots.
  - 5-level scope precedence resolver (`Task > Workflow > Project > Agent > Global`).
  - `invokeForAgent` dynamically resolves the assigned model at call time, invokes the provider adapter, and writes `model_invocations`, `token_usage`, and `cost_records`.
- **Tests:** 5-level precedence + Phase 3 Gate test in `apps/api/test/ai.e2e.test.ts`. ✅

## P3-10 — AI Playground & Benchmarks
- **Created:** `packages/ai-management/src/playground.ts`.
- **Capabilities (Blueprint §4.7):**
  - Isolated execution (`runPlayground`) and side-by-side multi-model comparison (`comparePlaygroundModels`) with saved benchmarks (`savePlaygroundBenchmark`).
  - Enforces output token cap (`8192`), pre-flight cost warning threshold (`$0.05` requiring `acknowledgeCostWarning: true`), and hard cost cap (`$0.50` or custom `maxEstimatedCostUsd`), with zero mutation of live `agent_model_configs`.
- **Tests:** cost warning, hard cost cap, multi-model comparison, and benchmark persistence tested in `apps/api/test/ai.e2e.test.ts`. ✅

## API (Blueprint §3.5 & §14)
`GET|POST /ai/providers` · `GET|PATCH /ai/providers/{id}` · `PUT|DELETE /ai/providers/{id}/credential` · `POST /ai/providers/{id}/test` · `GET /ai/providers/{id}/tests` · `POST /ai/providers/{id}/sync-models` · `GET|POST /ai/models` · `GET|PATCH /ai/models/{id}` · `POST /ai/models/{id}/pricing` · `POST /ai/models/{id}/test` · `GET|PUT /ai/configurations` · `GET /ai/configurations/{id}/history` · `POST /ai/configurations/resolve` · `POST /ai/invocations` · `POST /ai/playground/run` · `POST /ai/playground/compare` · `GET|POST /ai/playground/benchmarks` · `GET /ai/usage` · `GET /ai/costs`.

## Database
Migrations `0004_ai_management.sql` (13 tables + 12 enums) and `0005_ai_append_only.sql` (append-only triggers on `ai_model_pricing`, `agent_model_config_history`, `ai_connection_tests`, `model_invocations`, `token_usage`, `cost_records`, plus immutability guard `platform_credential_guard()` on `ai_provider_credentials`).

## Open issues & risks
| # | Item | Plan |
|---|------|------|
| R11 | Adaptive/hybrid model scoring, hard ceiling overlays, and automatic fallback state machine | Phase 4 (`packages/model-router`) |
| R12 | Multi-tier token & cost budget enforcement (50/70/85/95/100% thresholds) | Phase 4 (`packages/model-router`) |
| R13 | AI Management UI (`P3-11`) deferred with web shell (`P1-14`, `P2-10`) | Web UI sprint |
| R14 | Live provider calls not executed in CI sandbox (no real API keys / local Ollama on host) | Verified via contract fixtures; ready for live key probe at any time |

## Phase 3 Gate
**Passed** — `apps/api/test/ai.e2e.test.ts` proves: `architect` agent assigned to Provider A (`openai_compatible` / `gpt-4.1`) executes via `POST /ai/invocations` → reassigned via `PUT /ai/configurations` to Provider B (`anthropic` / `claude-sonnet-4`) → subsequent `POST /ai/invocations` call dynamically dispatches to Provider B / `claude-sonnet-4` without any agent code change or restart, recording full versioned config lineage, token usage, and estimated cost while keeping plaintext API keys completely unexposed.
