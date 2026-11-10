import type { modelCapabilityValues } from '@platform/db';

export type AdapterType = 'openai_compatible' | 'gemini' | 'anthropic';

export type ProbeResultKind =
  | 'connection_successful'
  | 'authentication_failed'
  | 'model_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'unsupported_capability'
  | 'unknown_error';

export type FailureKind = Exclude<ProbeResultKind, 'connection_successful'>;

export type ModelCapabilityKey = (typeof modelCapabilityValues)[number];
export type CapabilitySupport = 'yes' | 'no' | 'unknown';

export interface AdapterConnectionContext {
  baseUrl: string;
  apiKey: string | null;
  config: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DiscoveredModel {
  modelKey: string;
  displayName: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: Partial<Record<ModelCapabilityKey, CapabilitySupport>>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface InvocationRequest {
  modelKey: string;
  systemInstruction?: string;
  /**
   * Untrusted project/artifact context block (Blueprint §7.7). Always injected as a distinct user message
   * and never concatenated into `systemInstruction`.
   */
  untrustedContext?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  knownCapabilities?: Partial<Record<ModelCapabilityKey, CapabilitySupport>>;
}

export interface InvocationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

export interface InvocationResponse {
  text: string;
  structuredOutput: unknown | null;
  toolCalls: ToolCall[];
  usage: InvocationUsage;
  finishReason: string | null;
  providerRequestId: string | null;
  rawLatencyMs: number;
}

export interface ProbeResponse {
  result: ProbeResultKind;
  latencyMs: number;
  httpStatus: number | null;
  diagnostics: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly adapterType: AdapterType;
  declaredCapabilities(): Readonly<Record<ModelCapabilityKey, CapabilitySupport>>;
  listModels(ctx: AdapterConnectionContext): Promise<DiscoveredModel[]>;
  probe(ctx: AdapterConnectionContext, modelKey?: string): Promise<ProbeResponse>;
  invoke(ctx: AdapterConnectionContext, req: InvocationRequest): Promise<InvocationResponse>;
}

export class ProviderAdapterError extends Error {
  readonly kind: FailureKind;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly diagnostics: Record<string, unknown>;

  constructor(
    kind: FailureKind,
    message: string,
    opts: { httpStatus?: number | null; retryable?: boolean; diagnostics?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ProviderAdapterError';
    this.kind = kind;
    this.httpStatus = opts.httpStatus ?? null;
    this.retryable =
      opts.retryable ?? (kind === 'rate_limited' || kind === 'timeout' || (opts.httpStatus ?? 0) >= 500);
    this.diagnostics = opts.diagnostics ?? {};
  }
}

/**
 * Capability pre-flight check (Blueprint §4.4): never dispatch parameters for capabilities explicitly
 * marked `no` on the target model.
 */
export function validateRequestedCapabilities(
  req: InvocationRequest,
  adapterCapabilities?: Readonly<Record<ModelCapabilityKey, CapabilitySupport>>,
): void {
  const effective = (cap: ModelCapabilityKey): CapabilitySupport =>
    req.knownCapabilities?.[cap] ?? adapterCapabilities?.[cap] ?? 'unknown';

  if (req.tools && req.tools.length > 0 && effective('tool_calling') === 'no') {
    throw new ProviderAdapterError(
      'unsupported_capability',
      `Model '${req.modelKey}' does not support tool_calling`,
      { retryable: false, diagnostics: { capability: 'tool_calling', modelKey: req.modelKey } },
    );
  }
  if (req.jsonSchema && effective('structured_output') === 'no') {
    throw new ProviderAdapterError(
      'unsupported_capability',
      `Model '${req.modelKey}' does not support structured_output`,
      { retryable: false, diagnostics: { capability: 'structured_output', modelKey: req.modelKey } },
    );
  }
  if (req.reasoningEffort && effective('reasoning') === 'no') {
    throw new ProviderAdapterError(
      'unsupported_capability',
      `Model '${req.modelKey}' does not support reasoning`,
      { retryable: false, diagnostics: { capability: 'reasoning', modelKey: req.modelKey } },
    );
  }
}

export function classifyHttpFailure(status: number, bodyText: string): ProviderAdapterError {
  const lower = bodyText.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    lower.includes('invalid_api_key') ||
    lower.includes('api_key_invalid') ||
    lower.includes('authentication_error') ||
    lower.includes('unauthorized') ||
    lower.includes('permission_denied')
  ) {
    return new ProviderAdapterError('authentication_failed', `Provider authentication failed (HTTP ${status})`, {
      httpStatus: status,
      retryable: false,
      diagnostics: { status, excerpt: bodyText.slice(0, 300) },
    });
  }
  if (status === 429 || lower.includes('rate_limit') || lower.includes('resource_exhausted')) {
    return new ProviderAdapterError('rate_limited', `Provider rate limit exceeded (HTTP ${status})`, {
      httpStatus: status,
      retryable: true,
      diagnostics: { status, excerpt: bodyText.slice(0, 300) },
    });
  }
  if (status === 408 || status === 504 || lower.includes('deadline_exceeded') || lower.includes('timed out')) {
    return new ProviderAdapterError('timeout', `Provider request timed out (HTTP ${status})`, {
      httpStatus: status,
      retryable: true,
      diagnostics: { status, excerpt: bodyText.slice(0, 300) },
    });
  }
  if (
    status === 404 ||
    status === 503 ||
    lower.includes('model_not_found') ||
    lower.includes('does not exist') ||
    lower.includes('not_found_error') ||
    lower.includes('overloaded') ||
    lower.includes('model is currently overloaded')
  ) {
    return new ProviderAdapterError('model_unavailable', `Model unavailable (HTTP ${status})`, {
      httpStatus: status,
      retryable: status >= 500,
      diagnostics: { status, excerpt: bodyText.slice(0, 300) },
    });
  }
  if (
    status === 400 &&
    (lower.includes('unsupported') ||
      lower.includes('not supported') ||
      lower.includes('response_format') ||
      lower.includes('tools is not supported') ||
      lower.includes('tool use is not supported'))
  ) {
    return new ProviderAdapterError(
      'unsupported_capability',
      `Provider rejected unsupported capability (HTTP ${status})`,
      {
        httpStatus: status,
        retryable: false,
        diagnostics: { status, excerpt: bodyText.slice(0, 300) },
      },
    );
  }
  return new ProviderAdapterError('unknown_error', `Provider error (HTTP ${status})`, {
    httpStatus: status,
    retryable: status >= 500,
    diagnostics: { status, excerpt: bodyText.slice(0, 300) },
  });
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    if (
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      msg.toLowerCase().includes('timeout') ||
      msg.toLowerCase().includes('abort')
    ) {
      throw new ProviderAdapterError('timeout', `Request timed out after ${timeoutMs}ms`, {
        retryable: true,
        diagnostics: { timeoutMs },
      });
    }
    throw new ProviderAdapterError('unknown_error', `Network failure contacting provider: ${msg}`, {
      retryable: true,
      diagnostics: { error: msg },
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
