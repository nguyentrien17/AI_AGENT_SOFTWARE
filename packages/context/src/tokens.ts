/**
 * Deterministic token estimate used for budgeting before a model is selected (Phase 4 replaces this with
 * provider-specific tokenizers via the Model Router). ~4 bytes per token is a conservative average for
 * English text and source code.
 */
export const BYTES_PER_TOKEN = 4;

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromBytes(Buffer.byteLength(text, 'utf8'));
}
