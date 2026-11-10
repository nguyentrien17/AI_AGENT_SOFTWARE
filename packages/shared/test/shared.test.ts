import { describe, expect, it } from 'vitest';
import {
  AppError,
  canonicalJson,
  hashJson,
  isUuid,
  maskSecret,
  NotFoundError,
  redact,
  redactString,
  registerSecret,
  REDACTED,
  sha256Hex,
  uuidv7,
  VersionConflictError,
} from '../src/index.js';

describe('uuidv7', () => {
  it('produces valid, version-7, time-ordered ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const t = Date.UTC(2030, 0, 1);
    const id = uuidv7(t);
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(t);
  });
});

describe('errors', () => {
  it('maps to RFC 7807 problem details', () => {
    const p = new NotFoundError('Project', 'abc').toProblem('/api/v1/projects/abc');
    expect(p).toMatchObject({
      status: 404,
      code: 'not_found',
      title: 'Not found',
      instance: '/api/v1/projects/abc',
    });
    expect(p.type).toContain('not_found');
  });

  it('carries extensions', () => {
    const e = new VersionConflictError('Artifact', 1, 2);
    expect(e).toBeInstanceOf(AppError);
    expect(e.toProblem()).toMatchObject({ status: 409, code: 'version_conflict', expected: 1, actual: 2 });
  });
});

describe('redaction', () => {
  it('redacts sensitive keys recursively', () => {
    const out = redact({
      user: 'a',
      password: 'hunter22',
      nested: { apiKey: 'x', ok: 1 },
      list: [{ token: 't' }],
    });
    expect(out).toEqual({
      user: 'a',
      password: REDACTED,
      nested: { apiKey: REDACTED, ok: 1 },
      list: [{ token: REDACTED }],
    });
  });

  it('redacts secret-looking values inside strings', () => {
    expect(redactString('key=sk-abcdefghijklmnop end')).toBe(`key=${REDACTED} end`);
    expect(redactString('Authorization: Bearer abc.def.ghijkl')).toContain(REDACTED);
    expect(redactString('AIzaSyA1234567890abcdefghijk')).toBe(REDACTED);
  });

  it('redacts registered runtime secrets', () => {
    registerSecret('my-custom-secret-value');
    expect(redactString('error contacting with my-custom-secret-value')).toBe(
      `error contacting with ${REDACTED}`,
    );
  });

  it('masks secrets showing only last 4 chars', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('sk-****abcd');
    expect(maskSecret('short')).toBe('****');
  });
});

describe('hashing', () => {
  it('sha256 matches known vector', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('canonical json is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashJson({ x: 1, y: 2 })).toBe(hashJson({ y: 2, x: 1 }));
  });
});
