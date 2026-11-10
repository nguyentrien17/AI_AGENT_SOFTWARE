import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

/**
 * Platform-level repository initialization (not an agent tool — agent Git access goes through the
 * Tool Executor in Phase 6). Uses argv arrays only; never shell interpolation.
 */
export async function gitInit(dir: string, defaultBranch = 'main'): Promise<void> {
  const opts = { cwd: dir, env: env(), timeout: 30_000 };
  await run('git', ['init', '-q', '-b', defaultBranch], opts);
  await run('git', ['config', 'user.name', 'AI Agent Platform'], opts);
  await run('git', ['config', 'user.email', 'platform@localhost'], opts);
  await run('git', ['add', '-A'], opts);
  await run('git', ['commit', '-q', '-m', 'chore: initialize project workspace'], opts);
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run('git', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Serializes git operations per repository (git's index lock forbids concurrent writers). */
async function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

/**
 * Commits all workspace changes (if any) and returns the HEAD commit hash. Returns null when the
 * directory is not a git repository.
 */
export async function gitCommitAll(dir: string, message: string): Promise<string | null> {
  if (!(await isGitRepo(dir))) return null;
  return withRepoLock(dir, async () => {
    const opts = { cwd: dir, env: env(), timeout: 60_000 };
    await run('git', ['add', '-A'], opts);
    const { stdout: status } = await run('git', ['status', '--porcelain'], opts);
    if (status.trim()) await run('git', ['commit', '-q', '-m', message], opts);
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], opts);
    return stdout.trim();
  });
}

/**
 * Creates a branch pointing at an existing commit without touching any working tree (used to expose a
 * checkpoint's code for review or recovery). Returns false when the branch already exists.
 */
export async function gitCreateBranchAt(dir: string, branch: string, commit: string): Promise<boolean> {
  if (!(await isGitRepo(dir))) return false;
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`Invalid commit '${commit}'`);
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.startsWith('-')) throw new Error(`Invalid branch '${branch}'`);
  return withRepoLock(dir, async () => {
    const opts = { cwd: dir, env: env(), timeout: 30_000 };
    const { stdout } = await run('git', ['branch', '--list', branch], opts);
    if (stdout.trim()) return false;
    await run('git', ['branch', branch, commit], opts);
    return true;
  });
}
