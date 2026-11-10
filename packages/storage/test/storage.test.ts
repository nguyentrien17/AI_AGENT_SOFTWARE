import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrityError, LocalStorage, PathEscapeError } from '../src/index.js';

let dir: string;
let storage: LocalStorage;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  storage = new LocalStorage(dir);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('writes atomically and returns sha256', async () => {
    const r = await storage.writeAtomic('a/b/c.txt', 'hello');
    expect(r.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(r.sizeBytes).toBe(5);
    expect((await storage.read('a/b/c.txt')).toString()).toBe('hello');
    const leftovers = (await fs.readdir(path.join(dir, 'a/b'))).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it.each(['../x', '../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini', 'a/../../x', 'a\0b'])(
    'rejects path escape: %s',
    async (p) => {
      expect(() => storage.resolve(p)).toThrow(PathEscapeError);
      await expect(storage.writeAtomic(p, 'x')).rejects.toBeInstanceOf(PathEscapeError);
    },
  );

  it('scoped storage cannot escape its scope', async () => {
    const scoped = storage.scoped('projects/p1');
    await scoped.writeAtomic('file.md', 'x');
    expect(await storage.exists('projects/p1/file.md')).toBe(true);
    expect(() => scoped.resolve('../p2/file.md')).toThrow(PathEscapeError);
  });

  it('stores content-addressed blobs idempotently and verifies integrity', async () => {
    const a = await storage.putBlob('content-1');
    const b = await storage.putBlob('content-1');
    expect(a).toEqual(b);
    expect((await storage.getBlob(a.uri)).toString()).toBe('content-1');

    // tamper with blob on disk
    const blobPath = path.join(dir, '.blobs', a.sha256.slice(0, 2), a.sha256);
    await fs.writeFile(blobPath, 'tampered');
    await expect(storage.getBlob(a.uri)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('rejects writes through a junction/symlink that points outside the root', async (ctx) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-outside-'));
    try {
      try {
        await fs.symlink(outside, path.join(dir, 'link'), 'junction');
      } catch (e) {
        // Some restricted environments forbid creating links; the guard cannot be exercised there.
        if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) return ctx.skip();
        throw e;
      }
      await expect(storage.writeAtomic('link/evil.txt', 'x')).rejects.toBeInstanceOf(PathEscapeError);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('lists directory entries sorted, empty for missing', async () => {
    await storage.writeAtomic('l/b.txt', '1');
    await storage.writeAtomic('l/a.txt', '1');
    expect(await storage.list('l')).toEqual(['a.txt', 'b.txt']);
    expect(await storage.list('missing')).toEqual([]);
  });
});
