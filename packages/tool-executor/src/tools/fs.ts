import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NotFoundError, sha256Hex, ValidationError } from '@platform/shared';
import { matchesAny } from '../glob.js';
import { PROTECTED_PREFIXES } from '../jail.js';
import type { ToolContext, ToolDefinition } from '../types.js';

const MAX_READ_BYTES = 512_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 1_000;

const pathProp = { type: 'string', minLength: 1, maxLength: 500 };

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8_000).includes(0);
}

export const fsReadFile: ToolDefinition<{ path: string; maxBytes?: number }> = {
  toolKey: 'fs_read_file',
  description: 'Read a UTF-8 text file from the task workspace.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: pathProp, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES } },
  },
  outputSchema: {
    type: 'object',
    required: ['path', 'content', 'sizeBytes', 'truncated', 'sha256'],
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      sizeBytes: { type: 'integer' },
      truncated: { type: 'boolean' },
      sha256: { type: 'string' },
      binary: { type: 'boolean' },
    },
  },
  action: 'read_file',
  requiredScopes: ['workspace:read'],
  timeoutSeconds: 10,
  risk: 'low',
  idempotent: true,
  requiresSandbox: false,
  redaction: { summarizeOutput: true },
  runtimes: ['any'],
  pathFields: [{ field: 'path', access: 'read' }],
  async handler(ctx, input) {
    const { rel, abs } = await ctx.jail.resolve(input.path);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new NotFoundError('File', rel);
    if (!stat.isFile()) throw new ValidationError(`'${rel}' is not a file`);
    const buf = await fs.readFile(abs);
    const limit = input.maxBytes ?? MAX_READ_BYTES;
    const binary = isBinary(buf);
    return {
      path: rel,
      content: binary ? '' : buf.subarray(0, limit).toString('utf8'),
      sizeBytes: buf.length,
      truncated: !binary && buf.length > limit,
      sha256: sha256Hex(buf),
      binary,
    };
  },
};

/** A directory is listable when it can contain something inside the agent's file scopes. */
function dirMayContainScope(dir: string, scopes: readonly string[]): boolean {
  if (dir === '.') return true;
  return scopes.some((s) => matchesAny(dir, [s]) || s.startsWith(`${dir}/`) || s.startsWith('**'));
}

export const fsListDir: ToolDefinition<{ path?: string; recursive?: boolean }> = {
  toolKey: 'fs_list_dir',
  description: 'List files and directories in the task workspace (only entries within your file scopes).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: pathProp, recursive: { type: 'boolean' } },
  },
  outputSchema: {
    type: 'object',
    required: ['entries', 'truncated'],
    properties: { entries: { type: 'array' }, truncated: { type: 'boolean' } },
  },
  action: 'read_file',
  requiredScopes: ['workspace:read'],
  timeoutSeconds: 10,
  risk: 'low',
  idempotent: true,
  requiresSandbox: false,
  redaction: {},
  runtimes: ['any'],
  pathFields: [],
  async handler(ctx: ToolContext, input) {
    const start = await ctx.jail.resolve(input.path ?? '.');
    if (!dirMayContainScope(start.rel, ctx.fileScopes)) {
      throw new ValidationError(`'${start.rel}' is outside your file scopes`);
    }
    const entries: Array<{ path: string; type: 'file' | 'dir'; sizeBytes?: number }> = [];
    let truncated = false;
    const walk = async (relDir: string, absDir: string): Promise<void> => {
      const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        const rel = relDir === '.' ? d.name : `${relDir}/${d.name}`;
        if (relDir === '.' && PROTECTED_PREFIXES.some((p) => d.name.toLowerCase() === p)) continue;
        if (d.isSymbolicLink()) continue; // never followed
        if (d.isDirectory()) {
          if (!dirMayContainScope(rel, ctx.fileScopes)) continue;
          entries.push({ path: rel, type: 'dir' });
          if (input.recursive) await walk(rel, path.join(absDir, d.name));
        } else if (d.isFile() && matchesAny(rel, ctx.fileScopes)) {
          const st = await fs.stat(path.join(absDir, d.name));
          entries.push({ path: rel, type: 'file', sizeBytes: st.size });
        }
      }
    };
    await walk(start.rel, start.abs);
    return { entries, truncated };
  },
};

export const fsWriteFile: ToolDefinition<{ path: string; content: string }> = {
  toolKey: 'fs_write_file',
  description: 'Create or overwrite a UTF-8 text file in the task workspace.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: { path: pathProp, content: { type: 'string', maxLength: MAX_WRITE_BYTES } },
  },
  outputSchema: {
    type: 'object',
    required: ['path', 'sizeBytes', 'sha256', 'created'],
    properties: {
      path: { type: 'string' },
      sizeBytes: { type: 'integer' },
      sha256: { type: 'string' },
      created: { type: 'boolean' },
    },
  },
  action: 'write_file',
  requiredScopes: ['workspace:write'],
  timeoutSeconds: 10,
  risk: 'medium',
  idempotent: true,
  requiresSandbox: false,
  redaction: { omitInputFields: ['content'] },
  runtimes: ['any'],
  pathFields: [{ field: 'path', access: 'write' }],
  async handler(ctx, input) {
    const { rel, abs } = await ctx.jail.resolve(input.path);
    const buf = Buffer.from(input.content, 'utf8');
    if (buf.length > MAX_WRITE_BYTES) throw new ValidationError(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    const before = await fs.lstat(abs).catch(() => null);
    if (before && !before.isFile()) throw new ValidationError(`'${rel}' exists and is not a regular file`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Re-check after creating parents: a racing link must not redirect the write.
    await ctx.jail.resolve(rel);
    const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, buf, { flag: 'wx' });
    try {
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return { path: rel, sizeBytes: buf.length, sha256: sha256Hex(buf), created: !before };
  },
};

export const fsDeleteFile: ToolDefinition<{ path: string }> = {
  toolKey: 'fs_delete_file',
  description: 'Delete one file (not a directory) from the task workspace.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: pathProp },
  },
  outputSchema: {
    type: 'object',
    required: ['path', 'deleted'],
    properties: { path: { type: 'string' }, deleted: { type: 'boolean' } },
  },
  action: 'delete_file',
  requiredScopes: ['workspace:write'],
  timeoutSeconds: 10,
  risk: 'medium',
  idempotent: true,
  requiresSandbox: false,
  redaction: {},
  runtimes: ['any'],
  pathFields: [{ field: 'path', access: 'write' }],
  async handler(ctx, input) {
    const { rel, abs } = await ctx.jail.resolve(input.path);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) return { path: rel, deleted: false };
    if (!st.isFile()) throw new ValidationError(`'${rel}' is not a regular file`);
    await fs.unlink(abs);
    return { path: rel, deleted: true };
  },
};
