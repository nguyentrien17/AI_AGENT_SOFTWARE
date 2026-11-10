import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, ForbiddenError, NotFoundError, sha256Hex } from '@platform/shared';

export interface StoredObject {
  sha256: string;
  sizeBytes: number;
}

export interface BlobRef extends StoredObject {
  uri: string;
}

/** File storage abstraction (ADR-006). Implementations: local filesystem (MVP), object storage (future). */
export interface StorageAdapter {
  readonly root: string;
  scoped(subPath: string): StorageAdapter;
  resolve(relPath: string): string;
  writeAtomic(relPath: string, data: string | Buffer): Promise<StoredObject>;
  read(relPath: string): Promise<Buffer>;
  exists(relPath: string): Promise<boolean>;
  mkdirp(relPath: string): Promise<void>;
  list(relPath: string): Promise<string[]>;
  /** Content-addressed immutable blob store. */
  putBlob(data: string | Buffer): Promise<BlobRef>;
  /** Reads a blob and verifies its SHA-256 before returning. */
  getBlob(uri: string): Promise<Buffer>;
}

export class PathEscapeError extends ForbiddenError {
  constructor(p: string) {
    super(`Path '${p}' escapes the storage root`);
  }
}

export class IntegrityError extends AppError {
  constructor(detail: string) {
    super({ status: 500, code: 'integrity_error', title: 'Integrity check failed', detail });
  }
}

const BLOB_DIR = '.blobs';

export class LocalStorage implements StorageAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  scoped(subPath: string): StorageAdapter {
    return new LocalStorage(this.resolve(subPath));
  }

  /** Path jail: rejects absolute paths, traversal and NUL bytes; result is always inside root. */
  resolve(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.includes('\0')) throw new PathEscapeError(String(relPath));
    const normalized = relPath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
      throw new PathEscapeError(relPath);
    }
    const full = path.resolve(this.root, normalized);
    const rel = path.relative(this.root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathEscapeError(relPath);
    return full;
  }

  /** Additionally rejects symlinks/junctions inside the root that point outside of it. */
  private async resolveReal(relPath: string): Promise<string> {
    const full = this.resolve(relPath);
    const rootReal = await fs.realpath(this.root).catch(() => null);
    let probe = full;
    // Walk up to the closest existing ancestor (still inside root) and verify its real path.
    for (;;) {
      const relToRoot = path.relative(this.root, probe);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return full; // nothing inside root exists yet
      let real: string;
      try {
        real = await fs.realpath(probe);
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) return full;
        probe = parent;
        continue;
      }
      const rel = path.relative(rootReal ?? this.root, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathEscapeError(relPath);
      return full;
    }
  }

  async writeAtomic(relPath: string, data: string | Buffer): Promise<StoredObject> {
    const full = await this.resolveReal(relPath);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(buf);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, full);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return { sha256: sha256Hex(buf), sizeBytes: buf.length };
  }

  async read(relPath: string): Promise<Buffer> {
    const full = await this.resolveReal(relPath);
    try {
      return await fs.readFile(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError('File', relPath);
      throw e;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(await this.resolveReal(relPath));
      return true;
    } catch (e) {
      if (e instanceof PathEscapeError) throw e;
      return false;
    }
  }

  async mkdirp(relPath: string): Promise<void> {
    await fs.mkdir(await this.resolveReal(relPath), { recursive: true });
  }

  async list(relPath: string): Promise<string[]> {
    const full = await this.resolveReal(relPath);
    try {
      return (await fs.readdir(full)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async putBlob(data: string | Buffer): Promise<BlobRef> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const sha = sha256Hex(buf);
    const rel = `${BLOB_DIR}/${sha.slice(0, 2)}/${sha}`;
    if (!(await this.exists(rel))) await this.writeAtomic(rel, buf);
    return { sha256: sha, sizeBytes: buf.length, uri: `blob://${sha}` };
  }

  async getBlob(uri: string): Promise<Buffer> {
    const m = /^blob:\/\/([0-9a-f]{64})$/.exec(uri);
    if (!m) throw new NotFoundError('Blob', uri);
    const sha = m[1]!;
    const buf = await this.read(`${BLOB_DIR}/${sha.slice(0, 2)}/${sha}`);
    if (sha256Hex(buf) !== sha) throw new IntegrityError(`Blob ${sha} content hash mismatch`);
    return buf;
  }
}
