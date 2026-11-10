import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { maskSecret, registerSecret, UnprocessableError, ValidationError } from '@platform/shared';

export interface EncryptedCredentialEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  keyVersion: number;
  maskedHint: string;
}

export interface SecretStore {
  isConfigured(): boolean;
  encrypt(plaintext: string): EncryptedCredentialEnvelope;
  decrypt(envelope: Omit<EncryptedCredentialEnvelope, 'maskedHint'>): string;
  rewrap(envelope: EncryptedCredentialEnvelope): EncryptedCredentialEnvelope;
}

export interface MasterKeyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError('Master key must not be empty');
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.byteLength !== KEY_BYTES) {
    throw new ValidationError(
      `Master key must decode to ${KEY_BYTES} bytes (got ${buf.byteLength}); provide 32-byte base64 or 64-char hex`,
    );
  }
  return buf;
}

/**
 * Envelope encryption store (ADR-008, Blueprint §3.2 & §12.1):
 * - Each credential gets a fresh random 256-bit DEK and 96-bit IV.
 * - The DEK is encrypted ("wrapped") under the active master KEK (`keyVersion`) with its own 96-bit IV + GCM tag.
 * - Plaintext is registered with `@platform/shared` secret redactor and never returned by any management API.
 */
export class EnvelopeSecretStore implements SecretStore {
  private readonly keyring: MasterKeyring | null;

  constructor(keyring: MasterKeyring | null) {
    if (keyring) {
      const active = keyring.keys.get(keyring.currentVersion);
      if (!active || active.byteLength !== KEY_BYTES) {
        throw new ValidationError(`Active master key version ${keyring.currentVersion} is missing or invalid`);
      }
      for (const [ver, k] of keyring.keys) {
        if (k.byteLength !== KEY_BYTES) {
          throw new ValidationError(`Master key version ${ver} must be ${KEY_BYTES} bytes`);
        }
      }
    }
    this.keyring = keyring;
  }

  static fromKey(rawKey: string, version = 1, previous: Record<number, string> = {}): EnvelopeSecretStore {
    const keys = new Map<number, Buffer>();
    for (const [v, k] of Object.entries(previous)) {
      keys.set(Number(v), parseMasterKey(k));
    }
    keys.set(version, parseMasterKey(rawKey));
    return new EnvelopeSecretStore({ currentVersion: version, keys });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EnvelopeSecretStore {
    const raw = env['PLATFORM_MASTER_KEY']?.trim();
    if (!raw) {
      return new EnvelopeSecretStore(null);
    }
    const version = Number(env['PLATFORM_MASTER_KEY_VERSION'] ?? '1');
    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError('PLATFORM_MASTER_KEY_VERSION must be a positive integer');
    }
    const previous: Record<number, string> = {};
    const prevRaw = env['PLATFORM_MASTER_KEY_PREVIOUS']?.trim();
    if (prevRaw) {
      for (const entry of prevRaw.split(',')) {
        const idx = entry.indexOf(':');
        if (idx <= 0) throw new ValidationError('PLATFORM_MASTER_KEY_PREVIOUS entries must be <version>:<key>');
        const v = Number(entry.slice(0, idx).trim());
        const k = entry.slice(idx + 1).trim();
        if (!Number.isInteger(v) || v < 1) {
          throw new ValidationError('Invalid key version in PLATFORM_MASTER_KEY_PREVIOUS');
        }
        previous[v] = k;
      }
    }
    return EnvelopeSecretStore.fromKey(raw, version, previous);
  }

  isConfigured(): boolean {
    return this.keyring !== null;
  }

  private requireKeyring(): MasterKeyring {
    if (!this.keyring) {
      throw new UnprocessableError(
        'PLATFORM_MASTER_KEY is not configured; cannot encrypt or decrypt provider credentials',
        'master_key_not_configured',
        { reason: 'master_key_not_configured' },
      );
    }
    return this.keyring;
  }

  encrypt(plaintext: string): EncryptedCredentialEnvelope {
    const kr = this.requireKeyring();
    const trimmed = plaintext.trim();
    if (trimmed.length < 4) {
      throw new ValidationError('Credential secret must be at least 4 characters');
    }
    registerSecret(trimmed);

    const kek = kr.keys.get(kr.currentVersion)!;
    const dek = randomBytes(KEY_BYTES);
    const dataIv = randomBytes(IV_BYTES);
    const dataCipher = createCipheriv(ALGO, dek, dataIv);
    const ciphertextBuf = Buffer.concat([dataCipher.update(trimmed, 'utf8'), dataCipher.final()]);
    const dataTag = dataCipher.getAuthTag();

    const wrapIv = randomBytes(IV_BYTES);
    const wrapCipher = createCipheriv(ALGO, kek, wrapIv);
    const wrappedDekCipher = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();
    dek.fill(0);

    const wrappedDek = [
      wrapIv.toString('base64'),
      wrapTag.toString('base64'),
      wrappedDekCipher.toString('base64'),
    ].join('.');

    return {
      ciphertext: ciphertextBuf.toString('base64'),
      iv: dataIv.toString('base64'),
      authTag: dataTag.toString('base64'),
      wrappedDek,
      keyVersion: kr.currentVersion,
      maskedHint: maskSecret(trimmed),
    };
  }

  decrypt(envelope: Omit<EncryptedCredentialEnvelope, 'maskedHint'>): string {
    const kr = this.requireKeyring();
    const kek = kr.keys.get(envelope.keyVersion);
    if (!kek) {
      throw new UnprocessableError(
        `Master key version ${envelope.keyVersion} is not available in keyring`,
        'unknown_key_version',
        { reason: 'unknown_key_version', keyVersion: envelope.keyVersion },
      );
    }
    const dek = unwrapDek(envelope.wrappedDek, kek);
    try {
      const decipher = createDecipheriv(ALGO, dek, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plainBuf = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      const plaintext = plainBuf.toString('utf8');
      registerSecret(plaintext);
      return plaintext;
    } catch {
      throw new UnprocessableError(
        'Credential authentication tag verification failed',
        'credential_decryption_failed',
        { reason: 'credential_decryption_failed' },
      );
    } finally {
      dek.fill(0);
    }
  }

  rewrap(envelope: EncryptedCredentialEnvelope): EncryptedCredentialEnvelope {
    const kr = this.requireKeyring();
    const oldKek = kr.keys.get(envelope.keyVersion);
    if (!oldKek) {
      throw new UnprocessableError(
        `Master key version ${envelope.keyVersion} is not available in keyring`,
        'unknown_key_version',
        { reason: 'unknown_key_version' },
      );
    }
    const dek = unwrapDek(envelope.wrappedDek, oldKek);
    try {
      const newKek = kr.keys.get(kr.currentVersion)!;
      const wrapIv = randomBytes(IV_BYTES);
      const wrapCipher = createCipheriv(ALGO, newKek, wrapIv);
      const wrappedDekCipher = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
      const wrapTag = wrapCipher.getAuthTag();
      return {
        ...envelope,
        wrappedDek: [
          wrapIv.toString('base64'),
          wrapTag.toString('base64'),
          wrappedDekCipher.toString('base64'),
        ].join('.'),
        keyVersion: kr.currentVersion,
      };
    } finally {
      dek.fill(0);
    }
  }
}

function unwrapDek(wrappedDek: string, kek: Buffer): Buffer {
  const parts = wrappedDek.split('.');
  if (parts.length !== 3) {
    throw new UnprocessableError('Malformed wrapped DEK envelope', 'credential_decryption_failed', {
      reason: 'credential_decryption_failed',
    });
  }
  const [wrapIvB64, wrapTagB64, wrappedCipherB64] = parts as [string, string, string];
  try {
    const decipher = createDecipheriv(ALGO, kek, Buffer.from(wrapIvB64, 'base64'));
    decipher.setAuthTag(Buffer.from(wrapTagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(wrappedCipherB64, 'base64')), decipher.final()]);
  } catch {
    throw new UnprocessableError('Wrapped DEK authentication failed', 'credential_decryption_failed', {
      reason: 'credential_decryption_failed',
    });
  }
}
