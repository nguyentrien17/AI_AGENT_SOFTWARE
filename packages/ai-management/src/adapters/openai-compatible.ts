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

function resolveEndpoint(baseUrl: string, subpath: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/v1') || /\/v\d+$/.test(base)) {
    return `${base}${subpath}`;
  }
  return `${base}/v1${subpath}`;
}

function buildHeaders(ctx: AdapterConnectionContext): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (ctx.apiKey) {
    headers['authorization'] = `Bearer ${ctx.apiKey}`;
  }
  if (typeof ctx.config['organization'] === 'string' && ctx.config['organization']) {
    headers['openai-organization'] = ctx.config['organization'];
  }
  return headers;
}

/**
 * OpenAI-compatible adapter (Blueprint §3.1, P3-03).
 * Supports OpenAI API, Ollama (`/v1`), vLLM, LM Studio, and compatible gateways.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly adapterType = 'openai_compatible' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  declaredCapabilities(): Readonly<Record<ModelCapabilityKey, CapabilitySupport>> {
    // Unknown by default because OpenAI-compatible endpoints host heterogeneous models (Blueprint §3.3).
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
    const url = resolveEndpoint(ctx.baseUrl, '/models');
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      { method: 'GET', headers: buildHeaders(ctx) },
      ctx.timeoutMs ?? 15_000,
      ctx.signal,
    );
    const text = await res.text();
    if (!res.ok) {
      throw classifyHttpFailure(res.status, text);
    }
    let parsed: { data?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
    } catch {
      throw new ProviderAdapterError('unknown_error', 'Invalid JSON returned from /models', {
        httpStatus: res.status,
      });
    }
    const items = Array.isArray(parsed.data) ? parsed.data : [];
    return items
      .map((item): DiscoveredModel | null => {
        const id = typeof item['id'] === 'string' ? item['id'].trim() : '';
        if (!id) return null;
        const contextWindow =
          typeof item['context_window'] === 'number'
            ? item['context_window']
            : typeof item['max_model_len'] === 'number'
              ? item['max_model_len']
              : null;
        return {
          modelKey: id,
          displayName: typeof item['name'] === 'string' ? item['name'] : id,
          contextWindow,
          maxOutputTokens: typeof item['max_output_tokens'] === 'number' ? item['max_output_tokens'] : null,
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

    const messages: Array<Record<string, unknown>> = [];
    if (req.systemInstruction && req.systemInstruction.trim().length > 0) {
      messages.push({ role: 'system', content: req.systemInstruction });
    }
    if (req.untrustedContext && req.untrustedContext.trim().length > 0) {
      messages.push({ role: 'user', content: req.untrustedContext });
    }
    for (const m of req.messages) {
      if (m.role === 'tool') {
        messages.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId ?? 'tool_call_0',
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: req.modelKey,
      messages,
    };
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.maxOutputTokens !== undefined) {
      const tokenParam =
        typeof ctx.config['maxTokensParam'] === 'string' ? ctx.config['maxTokensParam'] : 'max_tokens';
      body[tokenParam] = req.maxOutputTokens;
    }
    if (req.reasoningEffort) {
      body['reasoning_effort'] = req.reasoningEffort;
    }
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parametersSchema,
        },
      }));
    }
    if (req.jsonSchema) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: req.jsonSchema.name,
          strict: true,
          schema: req.jsonSchema.schema,
        },
      };
    }

    const url = resolveEndpoint(ctx.baseUrl, '/chat/completions');
    const started = Date.now();
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: buildHeaders(ctx),
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
      throw new ProviderAdapterError('unknown_error', 'Invalid JSON in /chat/completions response', {
        httpStatus: res.status,
      });
    }

    const choices = Array.isArray(payload['choices'])
      ? (payload['choices'] as Array<Record<string, unknown>>)
      : [];
    const first = choices[0] ?? {};
    const msg = (first['message'] as Record<string, unknown> | undefined) ?? {};
    const content = typeof msg['content'] === 'string' ? msg['content'] : '';
    const finishReason = typeof first['finish_reason'] === 'string' ? first['finish_reason'] : null;

    const rawToolCalls = Array.isArray(msg['tool_calls'])
      ? (msg['tool_calls'] as Array<Record<string, unknown>>)
      : [];
    const toolCalls: ToolCall[] = rawToolCalls.map((tc, idx) => {
      const fn = (tc['function'] as Record<string, unknown> | undefined) ?? {};
      const argStr = typeof fn['arguments'] === 'string' ? fn['arguments'] : '{}';
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argStr) as Record<string, unknown>;
      } catch {
        args = { _raw: argStr };
      }
      return {
        id: typeof tc['id'] === 'string' ? tc['id'] : `call_${idx}`,
        name: typeof fn['name'] === 'string' ? fn['name'] : 'unknown',
        arguments: args,
      };
    });

    let structuredOutput: unknown = null;
    if (req.jsonSchema && content.trim().length > 0) {
      try {
        structuredOutput = JSON.parse(content);
      } catch {
        throw new ProviderAdapterError(
          'unknown_error',
          'Model response did not parse as valid JSON for requested jsonSchema',
          { httpStatus: res.status, retryable: true },
        );
      }
    }

    const usageObj = (payload['usage'] as Record<string, unknown> | undefined) ?? undefined;
    const promptDetails =
      (usageObj?.['prompt_tokens_details'] as Record<string, unknown> | undefined) ?? undefined;
    const completionDetails =
      (usageObj?.['completion_tokens_details'] as Record<string, unknown> | undefined) ?? undefined;

    return {
      text: content,
      structuredOutput,
      toolCalls,
      usage: {
        inputTokens: typeof usageObj?.['prompt_tokens'] === 'number' ? usageObj['prompt_tokens'] : null,
        outputTokens:
          typeof usageObj?.['completion_tokens'] === 'number' ? usageObj['completion_tokens'] : null,
        cachedTokens:
          typeof promptDetails?.['cached_tokens'] === 'number' ? promptDetails['cached_tokens'] : null,
        reasoningTokens:
          typeof completionDetails?.['reasoning_tokens'] === 'number'
            ? completionDetails['reasoning_tokens']
            : null,
      },
      finishReason,
      providerRequestId:
        res.headers.get('x-request-id') ?? (typeof payload['id'] === 'string' ? payload['id'] : null),
      rawLatencyMs,
    };
  }
}
