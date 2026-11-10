/**
 * Secret redaction (Blueprint §3.2, §17). Applied to logs, audit payloads, telemetry and error output.
 */
const SENSITIVE_KEY_RE =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session)/i;

const VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, // Anthropic
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

export const REDACTED = '[REDACTED]';

const registeredSecrets = new Set<string>();

/** Register a runtime secret value (e.g. a decrypted key) so it is scrubbed wherever it appears. */
export function registerSecret(value: string): void {
  if (value && value.length >= 6) registeredSecrets.add(value);
}

export function unregisterSecret(value: string): void {
  registeredSecrets.delete(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const s of registeredSecrets) out = out.split(s).join(REDACTED);
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 20) return REDACTED as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Only string values under sensitive keys are masked (numeric fields such as `input_tokens` stay intact).
      out[k] = SENSITIVE_KEY_RE.test(k) && typeof v === 'string' ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Display mask for a secret, e.g. `sk-****abcd`. Never reveals more than the last 4 characters. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  const prefix = /^[a-z]{2,4}-/i.exec(secret)?.[0] ?? '';
  return `${prefix}****${secret.slice(-4)}`;
}
