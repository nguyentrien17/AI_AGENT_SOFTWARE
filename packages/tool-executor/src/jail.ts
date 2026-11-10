import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ForbiddenError, ValidationError } from '@platform/shared';

/** Areas no file tool may touch: repository internals and the versioned context store. */
export const PROTECTED_PREFIXES = ['.git', '.ai-context'] as const;

export class PathJailError extends ForbiddenError {
  readonly reason: string;
  constructor(input: string, reason: string) {
    super(`Path '${input}' is not allowed: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Normalizes an agent-supplied path to a workspace-relative POSIX path, or throws. Pure: rejects absolute
 * paths, drive letters, UNC paths, NUL bytes, `..` traversal and protected areas.
 */
export function normalizeToolPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new ValidationError('path must be a non-empty string');
  if (input.includes('\0')) throw new PathJailError(input, 'contains a NUL byte');
  const p = input.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new PathJailError(input, 'absolute paths are not allowed');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new PathJailError(input, 'parent-directory traversal is not allowed');
    // Windows silently strips trailing dots/spaces and supports alternate data streams (`file:stream`).
    if (/[. ]$/.test(seg) || seg.includes(':')) throw new PathJailError(input, `invalid path segment '${seg}'`);
    parts.push(seg);
  }
  if (parts.length === 0) return '.';
  const first = parts[0]!.toLowerCase();
  if (PROTECTED_PREFIXES.some((x) => first === x)) {
    throw new PathJailError(input, `'${parts[0]}' is managed by the platform`);
  }
  return parts.join('/');
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A directory jail for one task workspace. Every access resolves the real path of the target (or of its
 * closest existing ancestor) so that symlinks and junctions cannot lead outside the workspace or into a
 * protected area.
 */
export class WorkspaceJail {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async resolve(input: string): Promise<{ rel: string; abs: string }> {
    const rel = normalizeToolPath(input);
    const abs = path.resolve(this.root, rel);
    if (!inside(this.root, abs)) throw new PathJailError(input, 'outside the workspace');
    const rootReal = await fs.realpath(this.root);
    for (let probe = abs; ; probe = path.dirname(probe)) {
      let real: string | null = null;
      try {
        real = await fs.realpath(probe);
      } catch {
        // Fail closed: something exists here (a dangling or unreadable link) but cannot be resolved.
        if (await fs.lstat(probe).then(() => true, () => false)) {
          throw new PathJailError(input, 'an unresolvable link is in the way');
        }
        real = null; // does not exist yet: check the parent
      }
      if (real !== null) {
        if (!inside(rootReal, real)) throw new PathJailError(input, 'a link leads outside the workspace');
        const realRel = path.relative(rootReal, real).replace(/\\/g, '/');
        const top = realRel.split('/')[0]!.toLowerCase();
        if (PROTECTED_PREFIXES.some((x) => top === x)) throw new PathJailError(input, 'a link leads into a protected area');
        break;
      }
      if (path.dirname(probe) === probe || !inside(this.root, path.dirname(probe))) break;
    }
    return { rel, abs };
  }
}
