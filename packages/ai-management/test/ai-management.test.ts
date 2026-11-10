import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  aiConnectionTests,
  aiModelPricing,
  aiProviderCredentials,
  createTestDatabase,
  type DatabaseConnection,
} from '@platform/db';
import { bootstrapOwner } from '@platform/iam';
import { type Actor, redact } from '@platform/shared';
import {
  addModelPricing,
  AnthropicAdapter,
  computeEstimatedCost,
  createDefaultAdapterRegistry,
  createModel,
  createProvider,
  EnvelopeSecretStore,
  GeminiAdapter,
  OpenAiCompatibleAdapter,
  probeProviderConnection,
  ProviderAdapterRegistry,
  rotateProviderCredential,
  upsertAgentModelConfig,
} from '../src/index.js';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('hex');

describe('EnvelopeSecretStore (P3-01)', () => {
  it('encrypts with distinct IV/DEK per call, decrypts, and registers secret for redaction', () => {
    const store = EnvelopeSecretStore.fromKey(KEY_V1, 1);
    expect(store.isConfigured()).toBe(true);

    const rawSecret = 'sk-proj-super-secret-token-99887766';
    const env1 = store.encrypt(rawSecret);
    const env2 = store.encrypt(rawSecret);

    expect(env1.ciphertext).not.toBe(env2.ciphertext);
    expect(env1.iv).not.toBe(env2.iv);
    expect(env1.wrappedDek).not.toBe(env2.wrappedDek);
    expect(env1.ciphertext).not.toContain(rawSecret);
    expect(env1.maskedHint).toBe('sk-****7766');

    expect(store.decrypt(env1)).toBe(rawSecret);
    expect(store.decrypt(env2)).toBe(rawSecret);

    // Registered with @platform/shared redactor
    const scrubbed = redact({ message: `Failed with key ${rawSecret} on upstream` });
    expect(JSON.stringify(scrubbed)).not.toContain(rawSecret);
  });

  it('supports master key rotation and DEK re-wrapping across key versions', () => {
    const storeV1 = EnvelopeSecretStore.fromKey(KEY_V1, 1);
    const envV1 = storeV1.encrypt('sk-ant-rotate-test-123456');
    expect(envV1.keyVersion).toBe(1);

    const storeV2 = EnvelopeSecretStore.fromKey(KEY_V2, 2, { 1: KEY_V1 });
    expect(storeV2.decrypt(envV1)).toBe('sk-ant-rotate-test-123456');

    const rewrapped = storeV2.rewrap(envV1);
    expect(rewrapped.keyVersion).toBe(2);
    expect(rewrapped.ciphertext).toBe(envV1.ciphertext);

    const storeV2Only = EnvelopeSecretStore.fromKey(KEY_V2, 2);
    expect(storeV2Only.decrypt(rewrapped)).toBe('sk-ant-rotate-test-123456');
    expect(() => storeV2Only.decrypt(envV1)).toThrow(/not available in keyring/);
  });

  it('rejects tampered ciphertext/authTag and unconfigured master key', () => {
    const unconfigured = EnvelopeSecretStore.fromEnv({});
    expect(unconfigured.isConfigured()).toBe(false);
    expect(() => unconfigured.encrypt('sk-test-123456')).toThrow(/PLATFORM_MASTER_KEY is not configured/);

    const store = EnvelopeSecretStore.fromKey(KEY_V1, 1);
    const env = store.encrypt('sk-test-integrity-check');
    const badTag = Buffer.alloc(16, 0).toString('base64');
    expect(() => store.decrypt({ ...env, authTag: badTag })).toThrow(/verification failed/);
  });
});

/**
 * TEST-ONLY mock HTTP transport for verifying provider adapter protocol contracts and error classification
 * without external network access (labeled per Blueprint §20.3).
 */
describe('Provider Adapters & 7-state Probe Classification (P3-03..P3-06)', () => {
  it('OpenAiCompatibleAdapter separates untrustedContext from system prompt and parses tool calls + usage', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-123',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '{"ok":true}',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 45,
            prompt_tokens_details: { cached_tokens: 20 },
            completion_tokens_details: { reasoning_tokens: 10 },
          },
        }),
        { status: 200, headers: { 'x-request-id': 'req-openai-99' } },
      );
    };

    const adapter = new OpenAiCompatibleAdapter(mockFetch);
    const resp = await adapter.invoke(
      { baseUrl: 'https://api.openai.com', apiKey: 'sk-openai-key', config: {} },
      {
        modelKey: 'gpt-4.1',
        systemInstruction: 'You are the Architect agent.',
        untrustedContext: '[UNTRUSTED_CONTEXT] repo file contents [/UNTRUSTED_CONTEXT]',
        messages: [{ role: 'user', content: 'Design the schema.' }],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            parametersSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        jsonSchema: { name: 'output', schema: { type: 'object' } },
        temperature: 0.2,
        maxOutputTokens: 512,
      },
    );

    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(capturedHeaders['authorization']).toBe('Bearer sk-openai-key');
    const msgs = capturedBody['messages'] as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are the Architect agent.' });
    expect(msgs[1]).toEqual({
      role: 'user',
      content: '[UNTRUSTED_CONTEXT] repo file contents [/UNTRUSTED_CONTEXT]',
    });
    expect(msgs[2]).toEqual({ role: 'user', content: 'Design the schema.' });

    expect(resp.structuredOutput).toEqual({ ok: true });
    expect(resp.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', arguments: { path: 'src/index.ts' } },
    ]);
    expect(resp.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedTokens: 20,
      reasoningTokens: 10,
    });
    expect(resp.providerRequestId).toBe('req-openai-99');
  });

  it('GeminiAdapter uses x-goog-api-key header (never query string) and maps usageMetadata', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          responseId: 'gem-resp-1',
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                role: 'model',
                parts: [{ text: 'Gemini architecture response' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 80,
            candidatesTokenCount: 30,
            cachedContentTokenCount: 10,
            thoughtsTokenCount: 5,
          },
        }),
        { status: 200 },
      );
    };

    const adapter = new GeminiAdapter(mockFetch);
    const resp = await adapter.invoke(
      {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIzaSyTestGeminiKey1234',
        config: {},
      },
      {
        modelKey: 'models/gemini-2.5-pro',
        systemInstruction: 'System prompt',
        messages: [{ role: 'user', content: 'Hello Gemini' }],
      },
    );

    expect(capturedUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(capturedUrl).not.toContain('AIzaSyTestGeminiKey1234');
    expect(capturedHeaders['x-goog-api-key']).toBe('AIzaSyTestGeminiKey1234');
    expect(resp.text).toBe('Gemini architecture response');
    expect(resp.usage).toEqual({
      inputTokens: 80,
      outputTokens: 30,
      cachedTokens: 10,
      reasoningTokens: 5,
    });
  });

  it('AnthropicAdapter sends x-api-key + anthropic-version and parses text + tool_use blocks', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          id: 'msg_01',
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Anthropic review complete.' },
            { type: 'tool_use', id: 'toolu_1', name: 'check_lint', input: { strict: true } },
          ],
          usage: {
            input_tokens: 200,
            output_tokens: 60,
            cache_read_input_tokens: 50,
          },
        }),
        { status: 200 },
      );
    };

    const adapter = new AnthropicAdapter(mockFetch);
    const resp = await adapter.invoke(
      { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-key-9999', config: {} },
      {
        modelKey: 'claude-sonnet-4-20250514',
        systemInstruction: 'Review code carefully.',
        messages: [{ role: 'user', content: 'Review PR #1' }],
      },
    );

    expect(capturedHeaders['x-api-key']).toBe('sk-ant-key-9999');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(resp.text).toBe('Anthropic review complete.');
    expect(resp.toolCalls).toEqual([{ id: 'toolu_1', name: 'check_lint', arguments: { strict: true } }]);
    expect(resp.usage).toEqual({
      inputTokens: 200,
      outputTokens: 60,
      cachedTokens: 50,
      reasoningTokens: null,
    });
  });

  it('classifies all 7 probe results accurately (Blueprint §3.4)', async () => {
    const scenarios: Array<{
      status: number;
      body: string;
      throwAbort?: boolean;
      expected: string;
    }> = [
      { status: 200, body: JSON.stringify({ data: [{ id: 'm1' }] }), expected: 'connection_successful' },
      { status: 401, body: '{"error":"invalid_api_key"}', expected: 'authentication_failed' },
      { status: 404, body: '{"error":"model_not_found"}', expected: 'model_unavailable' },
      { status: 429, body: '{"error":"rate_limit_exceeded"}', expected: 'rate_limited' },
      { status: 0, body: '', throwAbort: true, expected: 'timeout' },
      {
        status: 400,
        body: '{"error":"response_format is not supported by this model"}',
        expected: 'unsupported_capability',
      },
      { status: 500, body: '{"error":"internal upstream crash"}', expected: 'unknown_error' },
    ];

    for (const sc of scenarios) {
      const adapter = new OpenAiCompatibleAdapter(async () => {
        if (sc.throwAbort) {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
        return new Response(sc.body, { status: sc.status });
      });

      const res = await adapter.probe({
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test-probe',
        config: {},
      });
      expect(res.result).toBe(sc.expected);
    }
  });
});

describe('Database append-only & credential immutability triggers (0005_ai_append_only.sql)', () => {
  let conn: DatabaseConnection;
  let owner: Actor;
  const secretStore = EnvelopeSecretStore.fromKey(KEY_V1, 1);

  beforeAll(async () => {
    conn = await createTestDatabase();
    const b = await bootstrapOwner(conn.db, {
      email: 'ai-admin@example.com',
      password: 'Password-12345!',
      displayName: 'AI Admin',
    });
    owner = { type: 'user', userId: b.user.id, workspaceId: b.workspaceId };
  });

  afterAll(async () => conn.close());

  it('blocks mutation/deletion of pricing, config history, connection tests, and credential envelopes', async () => {
    const prov = await createProvider(conn.db, secretStore, owner, {
      providerKey: 'openai-main',
      displayName: 'OpenAI Main',
      adapterType: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-immutable-cred-1234',
    });

    const model = await createModel(conn.db, owner, {
      providerId: prov.id,
      modelKey: 'gpt-4.1-mini',
      pricing: { inputPerMtok: '0.40', outputPerMtok: '1.60', verified: true },
    });

    // Pricing is append-only
    await expect(
      conn.db.update(aiModelPricing).set({ inputPerMtok: '0.01' }).where(eq(aiModelPricing.modelId, model.id)),
    ).rejects.toThrow(/append-only/);

    // Credential ciphertext cannot be mutated in place
    await expect(
      conn.db
        .update(aiProviderCredentials)
        .set({ ciphertext: 'tampered' })
        .where(eq(aiProviderCredentials.providerId, prov.id)),
    ).rejects.toThrow(/immutable/);

    // Credential rows cannot be deleted directly
    await expect(
      conn.db.delete(aiProviderCredentials).where(eq(aiProviderCredentials.providerId, prov.id)),
    ).rejects.toThrow(/cannot be deleted/);

    // Rotating deactivates old credential; old credential cannot be reactivated
    await rotateProviderCredential(conn.db, secretStore, owner, prov.id, 'sk-rotated-cred-5678');
    await expect(
      conn.db
        .execute(sql`UPDATE ai_provider_credentials SET active = true WHERE active = false`),
    ).rejects.toThrow(/cannot be reactivated/);

    // Config history is append-only
    const cfg = await upsertAgentModelConfig(conn.db, owner, {
      scope: 'agent',
      agentKey: 'developer',
      mode: 'fixed',
      primaryModelId: model.id,
    });
    await expect(
      conn.db.execute(
        sql`DELETE FROM agent_model_config_history WHERE config_id = ${cfg.id}`,
      ),
    ).rejects.toThrow(/append-only/);

    // Connection test history is append-only
    const reg = new ProviderAdapterRegistry([
      new OpenAiCompatibleAdapter(
        async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), { status: 200 }),
      ),
    ]);
    const probeRow = await probeProviderConnection(conn.db, secretStore, reg, owner, {
      providerId: prov.id,
    });
    await expect(
      conn.db.delete(aiConnectionTests).where(eq(aiConnectionTests.id, probeRow.id)),
    ).rejects.toThrow(/append-only/);

    // Cost computation uses verified pricing and leaves actualCost null
    const cost = await computeEstimatedCost(conn.db, model.id, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    expect(cost.estimatedCost).toBe('1.200000');
    expect(cost.actualCost).toBeNull();
    expect(cost.note).toBe('verified_pricing');

    // Add newer pricing row and verify latest effective price wins
    await addModelPricing(conn.db, owner, model.id, {
      inputPerMtok: '0.20',
      outputPerMtok: '0.80',
      verified: true,
    });
    const costAfter = await computeEstimatedCost(conn.db, model.id, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
    expect(costAfter.estimatedCost).toBe('0.600000');

    // Default registry smoke check
    expect(createDefaultAdapterRegistry().get('gemini').adapterType).toBe('gemini');
  });
});
