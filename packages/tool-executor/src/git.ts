import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, ForbiddenError } from '@platform/shared';
import { type ProcessResult, runProcess } from './process.js';

export const PROTECTED_BRANCHES = ['main', 'master', 'integration'] as const;

export class DestructiveGitError extends ForbiddenError {
  readonly operation: string;
  constructor(operation: string) {
    super(`Destructive git operation '${operation}' requires explicit policy permission and human approval`);
    this.operation = operation;
  }
}

export class GitCommandError extends AppError {
  constructor(args: readonly string[], result: ProcessResult) {
    super({
      status: 422,
      code: result.timedOut ? 'git_timeout' : 'git_failed',
      title: 'Git command failed',
      detail: `git ${args[0] ?? ''} ${result.timedOut ? 'timed out' : `exited with ${result.exitCode}`}: ${result.stderr.trim().slice(0, 500)}`,
    });
  }
}

/**
 * Classifies a git argv as destructive (Blueprint §11.4: force push, deleting protected branches, history
 * rewrites…). Returns the operation name, or null when the command is safe. Pure.
 */
export function destructiveGitOperation(args: readonly string[]): string | null {
  const [cmd, ...rest] = args;
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
  switch (cmd) {
    case 'push':
      if (has('--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d', '--prune')) return 'push --force/--delete';
      if (rest.some((a) => /^\+/.test(a) || /^:/.test(a))) return 'push with forced or deleting refspec';
      return null;
    case 'reset':
      return has('--hard', '--merge', '--keep') ? 'reset --hard' : null;
    case 'branch':
      if (has('-D', '-d', '--delete')) return 'branch delete';
      if (has('-f', '--force', '-M', '-C')) return 'branch force';
      return null;
    case 'clean':
      return 'clean';
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      return cmd;
    case 'update-ref':
      return has('-d', '--stdin') ? 'update-ref delete' : null;
    case 'tag':
      return has('-d', '--delete', '-f', '--force') ? 'tag delete/force' : null;
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? `stash ${rest[0]}` : null;
    case 'reflog':
      return rest[0] === 'expire' || rest[0] === 'delete' ? `reflog ${rest[0]}` : null;
    case 'gc':
      return has('--prune') ? 'gc --prune' : null;
    case 'checkout':
    case 'switch':
      return has('-f', '--force', '-B', '-C', '--discard-changes') ? `${cmd} --force` : null;
    default:
      return null;
  }
}

/**
 * Child processes never inherit the platform environment: provider keys and the master key must not reach
 * git (or anything git might spawn). Only what git needs to run is passed through.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'AI Agent Platform',
    GIT_AUTHOR_EMAIL: 'platform@localhost',
    GIT_COMMITTER_NAME: 'AI Agent Platform',
    GIT_COMMITTER_EMAIL: 'platform@localhost',
  };
}

export interface RunGitOptions {
  timeoutMs?: number;
  /** Approval id that authorizes a destructive operation. Without it destructive commands are refused. */
  approvedDestructive?: string;
  /** Non-zero exit codes that are expected answers rather than failures (e.g. merge-tree conflicts). */
  allowExitCodes?: number[];
}

/** The only way the tool executor runs git: argv array, no shell, no hooks, sanitized environment. */
export async function runGit(cwd: string, args: readonly string[], opts: RunGitOptions = {}): Promise<ProcessResult> {
  const destructive = destructiveGitOperation(args);
  if (destructive && !opts.approvedDestructive) throw new DestructiveGitError(destructive);
  // Hooks run arbitrary code: never run them on behalf of an agent.
  const argv = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args];
  const result = await runProcess('git', argv, { cwd, timeoutMs: opts.timeoutMs ?? 30_000, env: gitEnvironment() });
  if (result.timedOut || (result.exitCode !== 0 && !(opts.allowExitCodes ?? []).includes(result.exitCode ?? -1))) {
    throw new GitCommandError(args, result);
  }
  return result;
}

const locks = new Map<string, Promise<unknown>>();

/** Serializes operations that touch a repository's shared metadata (worktree list, branch refs). */
export async function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoDir).toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

export function taskBranch(taskId: string): string {
  return `task/${taskId}`;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Creates (or re-attaches after a crash) the isolated worktree for a task on branch `task/{taskId}`, so
 * parallel tasks never share a working directory (Blueprint §11.4).
 */
export async function ensureTaskWorktree(input: {
  repoDir: string;
  worktreeDir: string;
  taskId: string;
  baseBranch: string;
}): Promise<{ created: boolean }> {
  const branch = taskBranch(input.taskId);
  return withRepoLock(input.repoDir, async () => {
    if (await exists(path.join(input.worktreeDir, '.git'))) return { created: false };
    await fs.mkdir(path.dirname(input.worktreeDir), { recursive: true });
    await runGit(input.repoDir, ['worktree', 'prune']);
    const known = await runGit(input.repoDir, ['branch', '--list', branch]);
    if (known.stdout.trim()) await runGit(input.repoDir, ['worktree', 'add', input.worktreeDir, branch]);
    else await runGit(input.repoDir, ['worktree', 'add', '-b', branch, input.worktreeDir, input.baseBranch]);
    return { created: true };
  });
}

/** Removes a task worktree; the branch and its commits are kept. */
export async function removeTaskWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  await withRepoLock(repoDir, async () => {
    if (await exists(worktreeDir)) await runGit(repoDir, ['worktree', 'remove', '--force', worktreeDir]);
    await runGit(repoDir, ['worktree', 'prune']);
  });
}

export interface StatusEntry {
  path: string;
  status: string;
}

export async function gitStatus(worktreeDir: string): Promise<StatusEntry[]> {
  const res = await runGit(worktreeDir, ['status', '--porcelain=v1', '-uall', '-z']);
  return res.stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
}

/** Unified diff of everything the task changed relative to where it branched from, untracked files included. */
export async function gitDiffAgainstBase(
  worktreeDir: string,
  baseBranch: string,
  opts: { maxBytes?: number; paths?: string[] } = {},
): Promise<{ diff: string; truncated: boolean; files: string[] }> {
  await runGit(worktreeDir, ['add', '--intent-to-add', '--all']);
  const mergeBase = (await runGit(worktreeDir, ['merge-base', baseBranch, 'HEAD'])).stdout.trim();
  const pathspec = opts.paths?.length ? ['--', ...opts.paths] : [];
  const names = await runGit(worktreeDir, ['diff', '--name-only', '--no-ext-diff', mergeBase, ...pathspec]);
  const diff = await runGit(worktreeDir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, ...pathspec]);
  const max = opts.maxBytes ?? 200_000;
  const buf = Buffer.from(diff.stdout, 'utf8');
  return {
    diff: buf.length > max ? buf.subarray(0, max).toString('utf8') : diff.stdout,
    truncated: buf.length > max || diff.truncated,
    files: names.stdout.split('\n').filter(Boolean),
  };
}

/** Commits every change in the task worktree. Returns null when there is nothing to commit. */
export async function gitCommitAllChanges(worktreeDir: string, message: string): Promise<{ sha: string; files: string[] } | null> {
  await runGit(worktreeDir, ['add', '--all']);
  const staged = await runGit(worktreeDir, ['diff', '--cached', '--name-only']);
  const files = staged.stdout.split('\n').filter(Boolean);
  if (files.length === 0) return null;
  await runGit(worktreeDir, ['commit', '--quiet', '--no-verify', '-m', message]);
  return { sha: (await runGit(worktreeDir, ['rev-parse', 'HEAD'])).stdout.trim(), files };
}

export async function gitLog(worktreeDir: string, limit: number): Promise<Array<{ sha: string; subject: string }>> {
  const res = await runGit(worktreeDir, ['log', `-n${limit}`, '--format=%H%x09%s']);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\t');
      return { sha: sha!, subject: subject.join('\t') };
    });
}

/**
 * Pre-merge conflict detection (Blueprint §11.4) without touching any working tree: `git merge-tree`
 * computes the merge in memory.
 */
export async function gitCheckMerge(worktreeDir: string, targetBranch: string): Promise<{ clean: boolean; conflicts: string[] }> {
  const res = await runGit(
    worktreeDir,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', targetBranch, 'HEAD'],
    { allowExitCodes: [1] },
  );
  if (res.exitCode === 0) return { clean: true, conflicts: [] };
  const [, ...files] = res.stdout.split('\n').filter(Boolean);
  return { clean: false, conflicts: [...new Set(files)] };
}
