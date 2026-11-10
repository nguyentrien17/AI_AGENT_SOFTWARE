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

function resolveAnthropicEndpoint(baseUrl: string, subpath: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/v1')) {
    return `${base}${subpath}`;
  }
  return `${base}/v1${subpath}`;
}

function buildHeaders(ctx: AdapterConnectionContext): Record<string, string> {
  if (!ctx.apiKey) {
    throw new ProviderAdapterError('authentication_failed', 'Anthropic API key is required', {
      retryable: false,
    });
  }
  const version =
    typeof ctx.config['anthropicVersion'] === 'string' && ctx.config['anthropicVersion']
      ? ctx.config['anthropicVersion']
      : '2023-06-01';
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-api-key': ctx.apiKey,
    'anthropic-version': version,
  };
}

/**
 * Anthropic Messages REST adapter (Blueprint §3.1, P3-05).
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly adapterType = 'anthropic' as const;
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
      embeddings: 'no',
    };
  }

  async listModels(ctx: AdapterConnectionContext): Promise<DiscoveredModel[]> {
    const headers = buildHeaders(ctx);
    const url = resolveAnthropicEndpoint(ctx.baseUrl, '/models');
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
    let parsed: { data?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
    } catch {
      throw new ProviderAdapterError('unknown_error', 'Invalid JSON returned from Anthropic /models', {
        httpStatus: res.status,
      });
    }
    const items = Array.isArray(parsed.data) ? parsed.data : [];
    return items
      .map((item): DiscoveredModel | null => {
        const id = typeof item['id'] === 'string' ? item['id'].trim() : '';
        if (!id) return null;
        return {
          modelKey: id,
          displayName: typeof item['display_name'] === 'string' ? item['display_name'] : id,
          contextWindow: null,
          maxOutputTokens: null,
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

    const messages: Array<Record<string, unknown>> = [];
    if (req.untrustedContext && req.untrustedContext.trim().length > 0) {
      messages.push({ role: 'user', content: req.untrustedContext });
    }
    for (const m of req.messages) {
      if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId ?? 'tool_call_0', content: m.content };
        // All results of one assistant turn belong in a single user message.
        const prev = messages[messages.length - 1];
        if (prev?.['role'] === 'user' && Array.isArray(prev['content']) && (prev['content'] as Array<Record<string, unknown>>).every((b) => b['type'] === 'tool_result')) {
          (prev['content'] as unknown[]).push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })),
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: req.modelKey,
      max_tokens: req.maxOutputTokens ?? 1024,
      messages,
    };
    if (req.systemInstruction && req.systemInstruction.trim().length > 0) {
      body['system'] = req.systemInstruction;
    }
    if (req.temperature !== undefined) {
      body['temperature'] = req.temperature;
    }
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parametersSchema,
      }));
    }

    const url = resolveAnthropicEndpoint(ctx.baseUrl, '/messages');
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
      throw new ProviderAdapterError('unknown_error', 'Invalid JSON in Anthropic /messages response', {
        httpStatus: res.status,
      });
    }

    const blocks = Array.isArray(payload['content'])
      ? (payload['content'] as Array<Record<string, unknown>>)
      : [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    blocks.forEach((b, idx) => {
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        textParts.push(b['text']);
      } else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
        toolCalls.push({
          id: typeof b['id'] === 'string' ? b['id'] : `anthropic_call_${idx}`,
          name: b['name'],
          arguments:
            b['input'] && typeof b['input'] === 'object' ? (b['input'] as Record<string, unknown>) : {},
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

    const usageObj = (payload['usage'] as Record<string, unknown> | undefined) ?? undefined;
    return {
      text,
      structuredOutput,
      toolCalls,
      usage: {
        inputTokens: typeof usageObj?.['input_tokens'] === 'number' ? usageObj['input_tokens'] : null,
        outputTokens: typeof usageObj?.['output_tokens'] === 'number' ? usageObj['output_tokens'] : null,
        cachedTokens:
          typeof usageObj?.['cache_read_input_tokens'] === 'number'
            ? usageObj['cache_read_input_tokens']
            : null,
        reasoningTokens: null,
      },
      finishReason: typeof payload['stop_reason'] === 'string' ? payload['stop_reason'] : null,
      providerRequestId:
        res.headers.get('request-id') ?? (typeof payload['id'] === 'string' ? payload['id'] : null),
      rawLatencyMs,
    };
  }
}
