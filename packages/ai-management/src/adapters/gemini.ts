import {
  type AdapterConnectionContext,
  type CapabilitySupport,
  classifyHttpFailure,
  type DiscoveredModel,
  fetchWithTimeout,
  type InvocationRequest,
  type InvocationResponse,
  type ModelCapabilityKey,
  normalizeBaseUrl,
  type ProbeResponse,
  type ProviderAdapter,
  ProviderAdapterError,
  type ToolCall,
  validateRequestedCapabilities,
} from './types.js';

function resolveGeminiBase(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/v1(beta|alpha)?$/.test(base)) {
    return base;
  }
  return `${base}/v1beta`;
}

function stripModelPrefix(key: string): string {
  return key.startsWith('models/') ? key.slice('models/'.length) : key;
}

function buildHeaders(ctx: AdapterConnectionContext): Record<string, string> {
  if (!ctx.apiKey) {
    throw new ProviderAdapterError('authentication_failed', 'Gemini API key is required', {
      retryable: false,
    });
  }
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-goog-api-key': ctx.apiKey,
  };
}

/**
 * Google Gemini REST adapter (Blueprint §3.1, P3-04).
 * Sends credentials exclusively via the `x-goog-api-key` HTTP header (never in URL query strings).
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly adapterType = 'gemini' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  declaredCapabilities(): Readonly<Record<ModelCapabilityKey, CapabilitySupport>> {
    return {
      tool_calling: 'unknown',
      structured_output: 'unknown',
      vision: 'unknown',
      streaming: 'unknown',
      reasoning: 'unknown',
      prompt_caching: 'unknown',
      embeddings: 'unknown',
    };
  }

  async listModels(ctx: AdapterConnectionContext): Promise<DiscoveredModel[]> {
    const headers = buildHeaders(ctx);
    const url = `${resolveGeminiBase(ctx.baseUrl)}/models`;
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      { method: 'GET', headers },
      ctx.timeoutMs ?? 15_000,
      ctx.signal,
    );
    const text = await res.text();
    if (!res.ok) {
      throw classifyHttpFailure(res.status, text);
    }
    let parsed: { models?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(text) as { models?: Array<Record<string, unknown>> };
    } catch {
      throw new ProviderAdapterError('unknown_error', 'Invalid JSON returned from Gemini /models', {
        httpStatus: res.status,
      });
    }
    const items = Array.isArray(parsed.models) ? parsed.models : [];
    return items
      .map((item): DiscoveredModel | null => {
        const rawName = typeof item['name'] === 'string' ? item['name'].trim() : '';
        if (!rawName) return null;
        const modelKey = stripModelPrefix(rawName);
        return {
          modelKey,
          displayName: typeof item['displayName'] === 'string' ? item['displayName'] : modelKey,
          contextWindow: typeof item['inputTokenLimit'] === 'number' ? item['inputTokenLimit'] : null,
          maxOutputTokens: typeof item['outputTokenLimit'] === 'number' ? item['outputTokenLimit'] : null,
        };
      })
      .filter((m): m is DiscoveredModel => m !== null);
  }

  async probe(ctx: AdapterConnectionContext, modelKey?: string): Promise<ProbeResponse> {
    const started = Date.now();
    try {
      if (modelKey) {
        const resp = await this.invoke(ctx, {
          modelKey,
          messages: [{ role: 'user', content: 'ping' }],
          maxOutputTokens: 1,
          temperature: 0,
        });
        return {
          result: 'connection_successful',
          latencyMs: resp.rawLatencyMs,
          httpStatus: 200,
          diagnostics: { modelKey, providerRequestId: resp.providerRequestId },
        };
      }
      const models = await this.listModels(ctx);
      return {
        result: 'connection_successful',
        latencyMs: Math.max(1, Date.now() - started),
        httpStatus: 200,
        diagnostics: { discoveredModels: models.length },
      };
    } catch (err) {
      const latencyMs = Math.max(1, Date.now() - started);
      if (err instanceof ProviderAdapterError) {
        return {
          result: err.kind,
          latencyMs,
          httpStatus: err.httpStatus,
          diagnostics: { message: err.message, ...err.diagnostics },
        };
      }
      return {
        result: 'unknown_error',
        latencyMs,
        httpStatus: null,
        diagnostics: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async invoke(ctx: AdapterConnectionContext, req: InvocationRequest): Promise<InvocationResponse> {
    validateRequestedCapabilities(req, this.declaredCapabilities());
    const headers = buildHeaders(ctx);

    const contents: Array<Record<string, unknown>> = [];
    if (req.untrustedContext && req.untrustedContext.trim().length > 0) {
      contents.push({
        role: 'user',
        parts: [{ text: req.untrustedContext }],
      });
    }
    for (const m of req.messages) {
      if (m.role === 'tool') {
        const part = { functionResponse: { name: m.toolName ?? 'tool', response: { result: m.content } } };
        // All responses of one model turn belong in a single content entry.
        const prev = contents[contents.length - 1];
        if (prev?.['role'] === 'user' && (prev['parts'] as Array<Record<string, unknown>>).every((x) => 'functionResponse' in x)) {
          (prev['parts'] as unknown[]).push(part);
        } else {
          contents.push({ role: 'user', parts: [part] });
        }
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        contents.push({
          role: 'model',
          parts: [
            ...(m.content ? [{ text: m.content }] : []),
            ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.arguments } })),
          ],
        });
      } else {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        });
      }
    }

    const body: Record<string, unknown> = { contents };
    if (req.systemInstruction && req.systemInstruction.trim().length > 0) {
      body['systemInstruction'] = {
        parts: [{ text: req.systemInstruction }],
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
    if (req.maxOutputTokens !== undefined) generationConfig['maxOutputTokens'] = req.maxOutputTokens;
    if (req.jsonSchema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = req.jsonSchema.schema;
    }
    if (Object.keys(generationConfig).length > 0) {
      body['generationConfig'] = generationConfig;
    }

    if (req.tools && req.tools.length > 0) {
      body['tools'] = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parametersSchema,
          })),
        },
      ];
    }

    const cleanModel = stripModelPrefix(req.modelKey);
    const url = `${resolveGeminiBase(ctx.baseUrl)}/models/${encodeURIComponent(cleanModel)}:generateContent`;
    const started = Date.now();
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      ctx.timeoutMs ?? 60_000,
      ctx.signal,
    );
    const rawLatencyMs = Math.max(1, Date.now() - started);
    const rawText = await res.text();
    if (!res.ok) {
      throw classifyHttpFailure(res.status, rawText);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw new ProviderAdapterError('unknown_error', 'Invalid JSON in Gemini generateContent response', {
        httpStatus: res.status,
      });
    }

    const candidates = Array.isArray(payload['candidates'])
      ? (payload['candidates'] as Array<Record<string, unknown>>)
      : [];
    const first = candidates[0] ?? {};
    const contentObj = (first['content'] as Record<string, unknown> | undefined) ?? {};
    const parts = Array.isArray(contentObj['parts'])
      ? (contentObj['parts'] as Array<Record<string, unknown>>)
      : [];

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    parts.forEach((p, idx) => {
      if (typeof p['text'] === 'string') {
        textParts.push(p['text']);
      }
      const fc = p['functionCall'] as Record<string, unknown> | undefined;
      if (fc && typeof fc['name'] === 'string') {
        toolCalls.push({
          id: typeof fc['id'] === 'string' ? fc['id'] : `gemini_call_${idx}`,
          name: fc['name'],
          arguments:
            fc['args'] && typeof fc['args'] === 'object' ? (fc['args'] as Record<string, unknown>) : {},
        });
      }
    });

    const text = textParts.join('');
    let structuredOutput: unknown = null;
    if (req.jsonSchema && text.trim().length > 0) {
      try {
        structuredOutput = JSON.parse(text);
      } catch {
        // Not a provider failure: the model answered, and its tokens were billed. The caller validates the
        // text against its own contract (e.g. the agent runtime's bounded output repair).
        structuredOutput = null;
      }
    }

    const usageMeta = (payload['usageMetadata'] as Record<string, unknown> | undefined) ?? undefined;
    return {
      text,
      structuredOutput,
      toolCalls,
      usage: {
        inputTokens:
          typeof usageMeta?.['promptTokenCount'] === 'number' ? usageMeta['promptTokenCount'] : null,
        outputTokens:
          typeof usageMeta?.['candidatesTokenCount'] === 'number' ? usageMeta['candidatesTokenCount'] : null,
        cachedTokens:
          typeof usageMeta?.['cachedContentTokenCount'] === 'number'
            ? usageMeta['cachedContentTokenCount']
            : null,
        reasoningTokens:
          typeof usageMeta?.['thoughtsTokenCount'] === 'number' ? usageMeta['thoughtsTokenCount'] : null,
      },
      finishReason: typeof first['finishReason'] === 'string' ? first['finishReason'] : null,
      providerRequestId:
        res.headers.get('x-request-id') ??
        (typeof payload['responseId'] === 'string' ? payload['responseId'] : null),
      rawLatencyMs,
    };
  }
}
