import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * RFC 9562 UUIDv7: 48-bit unix ms timestamp + version + 12-bit monotonic counter + variant + random.
 * Monotonic within a process (counter increments when called multiple times in the same millisecond).
 */
export function uuidv7(now: number = Date.now()): string {
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) ms = ++lastMs; // counter overflow → borrow next millisecond
  } else {
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff; // leave headroom for increments
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Cryptographically random URL-safe token (used for session ids). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
