import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AnthropicAdapter,
  EnvelopeSecretStore,
  GeminiAdapter,
  OpenAiCompatibleAdapter,
  ProviderAdapterRegistry,
} from '@platform/ai-management';
import { createTestDatabase, type DatabaseConnection } from '@platform/db';
import { LocalStorage } from '@platform/storage';
import { buildApp } from '../src/app.js';

const MASTER_KEY = randomBytes(32).toString('base64');
const SECRET_OPENAI_KEY = 'sk-proj-OpenAiPlaintextNeverLeaks991122';
const SECRET_ANTHROPIC_KEY = 'sk-ant-AnthropicPlaintextNeverLeaks334455';

/**
 * TEST-ONLY mock HTTP fetch simulating Provider A (OpenAI-compatible) and Provider B (Anthropic)
 * without external network access (labeled per Blueprint §20.3).
 */
function createMockProviderFetch(): {
  fetchImpl: typeof fetch;
  dispatchedCalls: Array<{ url: string; model: string; authHeader: string }>;
} {
  const dispatchedCalls: Array<{ url: string; model: string; authHeader: string }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers as Record<string, string>) ?? {};

    if (url.endsWith('/v1/models') && url.includes('openai.local')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4.1', name: 'GPT-4.1', context_window: 128000, max_output_tokens: 16384 },
            { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', context_window: 128000 },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const model = String(body['model'] ?? '');
      dispatchedCalls.push({
        url,
        model,
        authHeader: headers['authorization'] ?? '',
      });
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-prov-a',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: `Response from Provider A (${model})`,
              },
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
          },
        }),
        { status: 200, headers: { 'x-request-id': 'req-prov-a-1' } },
      );
    }

    if (url.endsWith('/v1/messages')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const model = String(body['model'] ?? '');
      dispatchedCalls.push({
        url,
        model,
        authHeader: headers['x-api-key'] ?? '',
      });
      return new Response(
        JSON.stringify({
          id: 'msg-prov-b',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: `Response from Provider B (${model})` }],
          usage: {
            input_tokens: 800,
            output_tokens: 400,
          },
        }),
        { status: 200, headers: { 'request-id': 'req-prov-b-1' } },
      );
    }

    return new Response('{"error":"not_found"}', { status: 404 });
  };

  return { fetchImpl, dispatchedCalls };
}

describe('Phase 3 AI Management E2E & Phase Gate', () => {
  let conn: DatabaseConnection;
  let storageDir: string;
  let app: FastifyInstance;
  let cookie: string;
  let dispatchedCalls: Array<{ url: string; model: string; authHeader: string }>;

  let providerAId: string;
  let providerBId: string;
  let modelA1Id: string;
  let modelB2Id: string;

  beforeAll(async () => {
    conn = await createTestDatabase();
    storageDir = await mkdtemp(join(tmpdir(), 'platform-ai-e2e-'));
    const secretStore = EnvelopeSecretStore.fromKey(MASTER_KEY, 1);
    const mock = createMockProviderFetch();
    dispatchedCalls = mock.dispatchedCalls;

    const adapterRegistry = new ProviderAdapterRegistry([
      new OpenAiCompatibleAdapter(mock.fetchImpl),
      new GeminiAdapter(mock.fetchImpl),
      new AnthropicAdapter(mock.fetchImpl),
    ]);

    app = await buildApp({
      db: conn.db,
      storage: new LocalStorage(storageDir),
      secretStore,
      adapterRegistry,
      initGit: false,
    });

    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: {
        email: 'owner@example.com',
        password: 'Owner-password-123!',
        displayName: 'Owner',
      },
    });
    expect(boot.statusCode).toBe(201);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'owner@example.com',
        password: 'Owner-password-123!',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    cookie = loginRes.headers['set-cookie'] as string;
  });

  afterAll(async () => {
    await app.close();
    await conn.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('registers providers, rotates credentials, and never exposes plaintext keys in API, DB, or audit logs', async () => {
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/providers',
      headers: { cookie },
      payload: {
        providerKey: 'provider-a-openai',
        displayName: 'Provider A (OpenAI)',
        adapterType: 'openai_compatible',
        baseUrl: 'https://openai.local/v1',
        apiKey: SECRET_OPENAI_KEY,
      },
    });
    expect(resA.statusCode).toBe(201);
    expect(resA.body).not.toContain(SECRET_OPENAI_KEY);
    const bodyA = resA.json();
    providerAId = bodyA.id;
    expect(bodyA.credential.hasCredential).toBe(true);
    expect(bodyA.credential.maskedHint).toBe('sk-****1122');

    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/providers',
      headers: { cookie },
      payload: {
        providerKey: 'provider-b-anthropic',
        displayName: 'Provider B (Anthropic)',
        adapterType: 'anthropic',
        baseUrl: 'https://anthropic.local/v1',
        apiKey: SECRET_ANTHROPIC_KEY,
      },
    });
    expect(resB.statusCode).toBe(201);
    expect(resB.body).not.toContain(SECRET_ANTHROPIC_KEY);
    providerBId = resB.json().id;

    // Verify database tables and audit logs contain zero occurrences of plaintext keys
    const dbCredDump = JSON.stringify(await conn.db.execute(sql`SELECT * FROM ai_provider_credentials`));
    const auditDump = JSON.stringify(await conn.db.execute(sql`SELECT * FROM audit_logs`));
    expect(dbCredDump).not.toContain(SECRET_OPENAI_KEY);
    expect(dbCredDump).not.toContain(SECRET_ANTHROPIC_KEY);
    expect(auditDump).not.toContain(SECRET_OPENAI_KEY);
    expect(auditDump).not.toContain(SECRET_ANTHROPIC_KEY);
  });

  it('syncs models with unverified metadata/unknown capabilities, then verifies & prices models', async () => {
    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/v1/ai/providers/${providerAId}/sync-models`,
      headers: { cookie },
    });
    expect(syncRes.statusCode).toBe(200);
    const synced = syncRes.json();
    expect(synced.added).toHaveLength(2);
    const gpt41 = synced.added.find((m: { modelKey: string }) => m.modelKey === 'gpt-4.1');
    expect(gpt41.metadataVerified).toBe(false);
    expect(gpt41.qualityTier).toBe('unknown');
    expect(gpt41.capabilities.tool_calling).toBe('unknown');
    modelA1Id = gpt41.id;

    // Administrator verifies capabilities & adds pricing for Model 1 (gpt-4.1)
    const patchM1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/ai/models/${modelA1Id}`,
      headers: { cookie },
      payload: {
        availability: 'available',
        qualityTier: 'high',
        metadataVerified: true,
        capabilities: {
          tool_calling: 'yes',
          structured_output: 'yes',
          reasoning: 'no',
        },
      },
    });
    expect(patchM1.statusCode).toBe(200);
    expect(patchM1.json().metadataVerified).toBe(true);

    const priceM1 = await app.inject({
      method: 'POST',
      url: `/api/v1/ai/models/${modelA1Id}/pricing`,
      headers: { cookie },
      payload: {
        inputPerMtok: '2.00',
        outputPerMtok: '8.00',
        currency: 'USD',
        source: 'official_pricelist',
        verified: true,
      },
    });
    expect(priceM1.statusCode).toBe(201);

    // Register Model 2 on Provider B (claude-sonnet-4)
    const createM2 = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/models',
      headers: { cookie },
      payload: {
        providerId: providerBId,
        modelKey: 'claude-sonnet-4',
        displayName: 'Claude Sonnet 4',
        availability: 'available',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        qualityTier: 'frontier',
        metadataVerified: true,
        capabilities: {
          tool_calling: 'yes',
          structured_output: 'yes',
          reasoning: 'yes',
        },
        pricing: {
          inputPerMtok: '3.00',
          outputPerMtok: '15.00',
          verified: true,
        },
      },
    });
    expect(createM2.statusCode).toBe(201);
    modelB2Id = createM2.json().id;

    // Probe Model 1 connectivity
    const probeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/ai/models/${modelA1Id}/test`,
      headers: { cookie },
    });
    expect(probeRes.statusCode).toBe(200);
    expect(probeRes.json().result).toBe('connection_successful');
  });

  it('PHASE 3 GATE: reassigns an agent from Provider A / Model 1 to Provider B / Model 2 via API and executes without touching agent code', async () => {
    dispatchedCalls.length = 0;

    // Step 1: Configure `architect` agent to use Provider A / Model 1 (gpt-4.1)
    const cfg1 = await app.inject({
      method: 'PUT',
      url: '/api/v1/ai/configurations',
      headers: { cookie },
      payload: {
        scope: 'agent',
        agentKey: 'architect',
        mode: 'fixed',
        primaryModelId: modelA1Id,
        params: { temperature: 0.1, maxOutputTokens: 512, toolCalling: true },
      },
    });
    expect(cfg1.statusCode).toBe(200);
    const cfg1Body = cfg1.json();
    expect(cfg1Body.configVersion).toBe(1);

    // Step 2: Execute `architect` agent invocation — no provider or model passed by caller!
    const inv1 = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/invocations',
      headers: { cookie },
      payload: {
        agentKey: 'architect',
        systemInstruction: 'Design system architecture.',
        messages: [{ role: 'user', content: 'Produce high-level component diagram.' }],
      },
    });
    expect(inv1.statusCode).toBe(200);
    const inv1Body = inv1.json();
    expect(inv1Body.providerKey).toBe('provider-a-openai');
    expect(inv1Body.modelKey).toBe('gpt-4.1');
    expect(inv1Body.configVersion).toBe(1);
    expect(inv1Body.response.text).toBe('Response from Provider A (gpt-4.1)');
    expect(inv1Body.estimatedCost).toBe('0.006000'); // (1000 * $2 + 500 * $8) / 1M = $0.006

    expect(dispatchedCalls).toHaveLength(1);
    expect(dispatchedCalls[0]).toEqual({
      url: 'https://openai.local/v1/chat/completions',
      model: 'gpt-4.1',
      authHeader: `Bearer ${SECRET_OPENAI_KEY}`,
    });

    // Step 3: Reassign `architect` agent to Provider B / Model 2 (claude-sonnet-4) via API
    const cfg2 = await app.inject({
      method: 'PUT',
      url: '/api/v1/ai/configurations',
      headers: { cookie },
      payload: {
        scope: 'agent',
        agentKey: 'architect',
        mode: 'fixed',
        primaryModelId: modelB2Id,
        params: { temperature: 0.2, maxOutputTokens: 1024, toolCalling: true },
      },
    });
    expect(cfg2.statusCode).toBe(200);
    expect(cfg2.json().configVersion).toBe(2);

    // Step 4: Execute the exact same `architect` agent call — dynamically routes to Provider B / Model 2!
    const inv2 = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/invocations',
      headers: { cookie },
      payload: {
        agentKey: 'architect',
        systemInstruction: 'Design system architecture.',
        messages: [{ role: 'user', content: 'Produce high-level component diagram.' }],
      },
    });
    expect(inv2.statusCode).toBe(200);
    const inv2Body = inv2.json();
    expect(inv2Body.providerKey).toBe('provider-b-anthropic');
    expect(inv2Body.modelKey).toBe('claude-sonnet-4');
    expect(inv2Body.configVersion).toBe(2);
    expect(inv2Body.response.text).toBe('Response from Provider B (claude-sonnet-4)');
    expect(inv2Body.estimatedCost).toBe('0.008400'); // (800 * $3 + 400 * $15) / 1M = $0.0084

    expect(dispatchedCalls).toHaveLength(2);
    expect(dispatchedCalls[1]).toEqual({
      url: 'https://anthropic.local/v1/messages',
      model: 'claude-sonnet-4',
      authHeader: SECRET_ANTHROPIC_KEY,
    });

    // Verify configuration history preserved both versions
    const histRes = await app.inject({
      method: 'GET',
      url: `/api/v1/ai/configurations/${cfg1Body.id}/history`,
      headers: { cookie },
    });
    expect(histRes.statusCode).toBe(200);
    expect(histRes.json().items.map((h: { configVersion: number }) => h.configVersion)).toEqual([2, 1]);
  });

  it('enforces 5-level scope precedence (Task > Workflow > Project > Agent > Global) and capability validation', async () => {
    // Rejects configuration requiring reasoning on a model where reasoning === 'no'
    const badCap = await app.inject({
      method: 'PUT',
      url: '/api/v1/ai/configurations',
      headers: { cookie },
      payload: {
        scope: 'agent',
        agentKey: 'qa',
        mode: 'fixed',
        primaryModelId: modelA1Id,
        params: { reasoningEffort: 'high' },
      },
    });
    expect(badCap.statusCode).toBe(422);

    const projectId = '01950000-0000-7000-8000-000000000001';
    const taskId = '01950000-0000-7000-8000-000000000002';

    await app.inject({
      method: 'PUT',
      url: '/api/v1/ai/configurations',
      headers: { cookie },
      payload: {
        scope: 'global',
        mode: 'fixed',
        primaryModelId: modelA1Id,
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/ai/configurations',
      headers: { cookie },
      payload: {
        scope: 'task',
        scopeRefId: taskId,
        agentKey: 'architect',
        mode: 'fixed',
        primaryModelId: modelA1Id,
      },
    });

    // Without taskId, architect resolves to agent scope (modelB2Id)
    const resAgent = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/configurations/resolve',
      headers: { cookie },
      payload: { agentKey: 'architect', projectId },
    });
    expect(resAgent.statusCode).toBe(200);
    expect(resAgent.json().config.scope).toBe('agent');
    expect(resAgent.json().selectedModelId).toBe(modelB2Id);

    // With taskId, task override wins over agent scope (modelA1Id)
    const resTask = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/configurations/resolve',
      headers: { cookie },
      payload: { agentKey: 'architect', projectId, taskId },
    });
    expect(resTask.statusCode).toBe(200);
    expect(resTask.json().config.scope).toBe('task');
    expect(resTask.json().selectedModelId).toBe(modelA1Id);
  });

  it('runs isolated AI Playground comparisons, enforces cost warning & hard cap, and aggregates usage/costs', async () => {
    // Hard cost cap check
    const capExceeded = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/playground/run',
      headers: { cookie },
      payload: {
        modelId: modelB2Id,
        userPrompt: 'Compare architectures.',
        params: { maxOutputTokens: 4000 },
        maxEstimatedCostUsd: 0.01, // 4000 output tokens @ $15/M = $0.06 > $0.01
      },
    });
    expect(capExceeded.statusCode).toBe(422);
    expect(capExceeded.json().code).toBe('playground_cost_cap_exceeded');

    // Cost warning check (>= $0.05 requires acknowledgeCostWarning: true)
    const warnRequired = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/playground/run',
      headers: { cookie },
      payload: {
        modelId: modelB2Id,
        userPrompt: 'Compare architectures.',
        params: { maxOutputTokens: 4000 }, // preflight ~$0.06 >= $0.05
      },
    });
    expect(warnRequired.statusCode).toBe(422);
    expect(warnRequired.json().code).toBe('playground_cost_warning_required');

    // Side-by-side comparison across Provider A / Model 1 and Provider B / Model 2
    const cmpRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/playground/compare',
      headers: { cookie },
      payload: {
        modelIds: [modelA1Id, modelB2Id],
        simulatedRole: 'architect',
        systemPrompt: 'Be concise.',
        userPrompt: 'Propose caching strategy.',
        params: { maxOutputTokens: 256 },
      },
    });
    expect(cmpRes.statusCode).toBe(200);
    const cmpBody = cmpRes.json();
    expect(cmpBody.results).toHaveLength(2);
    const runIds = cmpBody.results.map((r: { run: { id: string } }) => r.run.id);

    // Save benchmark
    const benchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/playground/benchmarks',
      headers: { cookie },
      payload: {
        name: 'Caching Strategy Benchmark',
        runIds,
        notes: 'Compared GPT-4.1 vs Claude Sonnet 4',
      },
    });
    expect(benchRes.statusCode).toBe(201);

    // Usage and cost telemetry endpoints
    const usageRes = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/usage',
      headers: { cookie },
    });
    expect(usageRes.statusCode).toBe(200);
    expect(usageRes.json().items.length).toBeGreaterThanOrEqual(4);

    const costsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/costs',
      headers: { cookie },
    });
    expect(costsRes.statusCode).toBe(200);
    const costsBody = costsRes.json();
    expect(costsBody.succeededInvocations).toBeGreaterThanOrEqual(4);
    expect(Number(costsBody.totalEstimatedCostUsd)).toBeGreaterThan(0);
  });
});
