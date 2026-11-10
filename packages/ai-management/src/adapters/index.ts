import { ValidationError } from '@platform/shared';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import type { AdapterType, ProviderAdapter } from './types.js';

export * from './types.js';
export * from './openai-compatible.js';
export * from './gemini.js';
export * from './anthropic.js';

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<AdapterType, ProviderAdapter>();

  constructor(adapters: Iterable<ProviderAdapter>) {
    for (const a of adapters) {
      this.adapters.set(a.adapterType, a);
    }
  }

  get(adapterType: AdapterType): ProviderAdapter {
    const adapter = this.adapters.get(adapterType);
    if (!adapter) {
      throw new ValidationError(`Unsupported provider adapter type '${adapterType}'`);
    }
    return adapter;
  }
}

export function createDefaultAdapterRegistry(
  fetchImpl: typeof fetch = globalThis.fetch,
): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry([
    new OpenAiCompatibleAdapter(fetchImpl),
    new GeminiAdapter(fetchImpl),
    new AnthropicAdapter(fetchImpl),
  ]);
}
