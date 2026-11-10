import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON serialization (sorted keys) for hashing structured data. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
